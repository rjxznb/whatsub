use crate::error::{AppError, AppResult};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub const DOWNLOAD_CAPACITY: usize = 3;
pub const COMPUTE_CAPACITY: usize = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JobPriority {
    Foreground,
    Background,
}

impl JobPriority {
    pub fn from_background(background: bool) -> Self {
        if background {
            Self::Background
        } else {
            Self::Foreground
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScheduledResource {
    Download,
    Compute,
}

#[derive(Clone)]
pub struct PipelineScheduler {
    download: Arc<PriorityPool>,
    compute: Arc<PriorityPool>,
}

impl Default for PipelineScheduler {
    fn default() -> Self {
        Self {
            download: Arc::new(PriorityPool::new(DOWNLOAD_CAPACITY)),
            compute: Arc::new(PriorityPool::new(COMPUTE_CAPACITY)),
        }
    }
}

impl PipelineScheduler {
    pub async fn acquire<F>(
        &self,
        resource: ScheduledResource,
        priority: JobPriority,
        cancel: &CancellationToken,
        on_wait: F,
    ) -> AppResult<PipelinePermit>
    where
        F: FnOnce(),
    {
        if cancel.is_cancelled() {
            return Err(AppError::Cancelled);
        }

        let pool = self.pool(resource);
        match pool.request(priority)? {
            AcquireRequest::Ready(permit) => Ok(permit),
            AcquireRequest::Waiting {
                waiter_id,
                mut receiver,
            } => {
                on_wait();
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        if !pool.remove_waiter(waiter_id)? {
                            if let Ok(permit) = receiver.await {
                                drop(permit);
                            }
                        }
                        Err(AppError::Cancelled)
                    }
                    delivered = &mut receiver => delivered.map_err(|_| {
                        AppError::Other("pipeline scheduler unavailable".to_string())
                    }),
                }
            }
        }
    }

    fn pool(&self, resource: ScheduledResource) -> Arc<PriorityPool> {
        match resource {
            ScheduledResource::Download => self.download.clone(),
            ScheduledResource::Compute => self.compute.clone(),
        }
    }
}

struct Waiter {
    id: u64,
    sender: oneshot::Sender<PipelinePermit>,
}

struct PoolState {
    available: usize,
    next_waiter_id: u64,
    foreground: VecDeque<Waiter>,
    background: VecDeque<Waiter>,
}

struct PriorityPool {
    state: Mutex<PoolState>,
}

impl PriorityPool {
    fn new(capacity: usize) -> Self {
        Self {
            state: Mutex::new(PoolState {
                available: capacity,
                next_waiter_id: 0,
                foreground: VecDeque::new(),
                background: VecDeque::new(),
            }),
        }
    }

    fn request(self: &Arc<Self>, priority: JobPriority) -> AppResult<AcquireRequest> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AppError::Other("pipeline scheduler poisoned".to_string()))?;
        if state.available > 0 {
            state.available -= 1;
            return Ok(AcquireRequest::Ready(PipelinePermit::new(self.clone())));
        }

        state.next_waiter_id += 1;
        let waiter_id = state.next_waiter_id;
        let (sender, receiver) = oneshot::channel();
        let waiter = Waiter {
            id: waiter_id,
            sender,
        };
        match priority {
            JobPriority::Foreground => state.foreground.push_back(waiter),
            JobPriority::Background => state.background.push_back(waiter),
        }
        Ok(AcquireRequest::Waiting {
            waiter_id,
            receiver,
        })
    }

    fn remove_waiter(&self, waiter_id: u64) -> AppResult<bool> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AppError::Other("pipeline scheduler poisoned".to_string()))?;
        let before = state.foreground.len() + state.background.len();
        state.foreground.retain(|waiter| waiter.id != waiter_id);
        state.background.retain(|waiter| waiter.id != waiter_id);
        Ok(before != state.foreground.len() + state.background.len())
    }

    fn release(self: &Arc<Self>) {
        loop {
            let next = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let next = state
                    .foreground
                    .pop_front()
                    .or_else(|| state.background.pop_front())
                    .map(|waiter| waiter.sender);
                if next.is_none() {
                    state.available += 1;
                }
                next
            };

            let Some(next) = next else {
                return;
            };

            let permit = PipelinePermit::new(self.clone());
            match next.send(permit) {
                Ok(()) => return,
                Err(mut undelivered) => {
                    // The waiter was cancelled at the dispatch boundary.
                    // Keep the slot in hand while looking for another live
                    // waiter; disarming prevents recursive release on drop.
                    undelivered.pool.take();
                }
            }
        }
    }
}

enum AcquireRequest {
    Ready(PipelinePermit),
    Waiting {
        waiter_id: u64,
        receiver: oneshot::Receiver<PipelinePermit>,
    },
}

pub struct PipelinePermit {
    pool: Option<Arc<PriorityPool>>,
}

impl PipelinePermit {
    fn new(pool: Arc<PriorityPool>) -> Self {
        Self { pool: Some(pool) }
    }
}

impl Drop for PipelinePermit {
    fn drop(&mut self) {
        if let Some(pool) = self.pool.take() {
            pool.release();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    const SHORT_WAIT: Duration = Duration::from_millis(40);
    const MUST_FINISH: Duration = Duration::from_millis(500);

    #[tokio::test]
    async fn download_pool_starts_three_and_blocks_the_fourth() {
        let scheduler = PipelineScheduler::default();
        let cancel = CancellationToken::new();
        let p1 = scheduler
            .acquire(
                ScheduledResource::Download,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();
        let p2 = scheduler
            .acquire(
                ScheduledResource::Download,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();
        let p3 = scheduler
            .acquire(
                ScheduledResource::Download,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();

        let fourth = scheduler.acquire(
            ScheduledResource::Download,
            JobPriority::Background,
            &cancel,
            || {},
        );
        tokio::pin!(fourth);
        assert!(tokio::time::timeout(SHORT_WAIT, &mut fourth).await.is_err());

        drop(p1);
        let p4 = tokio::time::timeout(MUST_FINISH, &mut fourth)
            .await
            .unwrap()
            .unwrap();
        drop((p2, p3, p4));
    }

    #[tokio::test]
    async fn compute_pool_allows_only_one() {
        let scheduler = PipelineScheduler::default();
        let cancel = CancellationToken::new();
        let first = scheduler
            .acquire(
                ScheduledResource::Compute,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();
        let second = scheduler.acquire(
            ScheduledResource::Compute,
            JobPriority::Background,
            &cancel,
            || {},
        );
        tokio::pin!(second);
        assert!(tokio::time::timeout(SHORT_WAIT, &mut second).await.is_err());

        drop(first);
        assert!(tokio::time::timeout(MUST_FINISH, &mut second)
            .await
            .unwrap()
            .is_ok());
    }

    #[tokio::test]
    async fn foreground_waiter_overtakes_queued_background_waiter() {
        let scheduler = PipelineScheduler::default();
        let held_cancel = CancellationToken::new();
        let held = scheduler
            .acquire(
                ScheduledResource::Compute,
                JobPriority::Background,
                &held_cancel,
                || {},
            )
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        for (label, priority) in [
            ("background", JobPriority::Background),
            ("foreground", JobPriority::Foreground),
        ] {
            let scheduler = scheduler.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let cancel = CancellationToken::new();
                let permit = scheduler
                    .acquire(ScheduledResource::Compute, priority, &cancel, || {})
                    .await
                    .unwrap();
                tx.send((label, permit)).unwrap();
            });
            tokio::task::yield_now().await;
        }

        drop(held);
        let (label, foreground) = tokio::time::timeout(MUST_FINISH, rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(label, "foreground");
        drop(foreground);

        let (label, background) = tokio::time::timeout(MUST_FINISH, rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(label, "background");
        drop(background);
    }

    #[tokio::test]
    async fn fifo_is_preserved_within_one_priority() {
        let scheduler = PipelineScheduler::default();
        let held_cancel = CancellationToken::new();
        let held = scheduler
            .acquire(
                ScheduledResource::Compute,
                JobPriority::Foreground,
                &held_cancel,
                || {},
            )
            .await
            .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();

        for label in ["first", "second"] {
            let scheduler = scheduler.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let cancel = CancellationToken::new();
                let permit = scheduler
                    .acquire(
                        ScheduledResource::Compute,
                        JobPriority::Background,
                        &cancel,
                        || {},
                    )
                    .await
                    .unwrap();
                tx.send((label, permit)).unwrap();
            });
            tokio::task::yield_now().await;
        }

        drop(held);
        let (label, first) = tokio::time::timeout(MUST_FINISH, rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(label, "first");
        drop(first);

        let (label, second) = tokio::time::timeout(MUST_FINISH, rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(label, "second");
        drop(second);
    }

    #[tokio::test]
    async fn cancelling_a_waiter_starts_nothing_and_leaks_no_slot() {
        let scheduler = PipelineScheduler::default();
        let held_cancel = CancellationToken::new();
        let held = scheduler
            .acquire(
                ScheduledResource::Compute,
                JobPriority::Background,
                &held_cancel,
                || {},
            )
            .await
            .unwrap();

        let waiter_cancel = CancellationToken::new();
        let wait_hook_calls = Arc::new(AtomicUsize::new(0));
        let hook_counter = wait_hook_calls.clone();
        let waiting = scheduler.acquire(
            ScheduledResource::Compute,
            JobPriority::Background,
            &waiter_cancel,
            move || {
                hook_counter.fetch_add(1, Ordering::SeqCst);
            },
        );
        tokio::pin!(waiting);

        assert!(tokio::time::timeout(SHORT_WAIT, &mut waiting)
            .await
            .is_err());
        assert_eq!(wait_hook_calls.load(Ordering::SeqCst), 1);
        waiter_cancel.cancel();
        assert!(matches!(
            tokio::time::timeout(MUST_FINISH, &mut waiting)
                .await
                .unwrap(),
            Err(AppError::Cancelled)
        ));

        drop(held);
        let fresh_cancel = CancellationToken::new();
        let fresh = tokio::time::timeout(
            MUST_FINISH,
            scheduler.acquire(
                ScheduledResource::Compute,
                JobPriority::Background,
                &fresh_cancel,
                || {},
            ),
        )
        .await
        .unwrap()
        .unwrap();
        drop(fresh);
    }

    #[tokio::test]
    async fn download_and_compute_pools_are_independent() {
        let scheduler = PipelineScheduler::default();
        let cancel = CancellationToken::new();
        let compute = scheduler
            .acquire(
                ScheduledResource::Compute,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();

        let download = tokio::time::timeout(
            MUST_FINISH,
            scheduler.acquire(
                ScheduledResource::Download,
                JobPriority::Background,
                &cancel,
                || {},
            ),
        )
        .await
        .unwrap()
        .unwrap();
        drop((compute, download));
    }

    #[tokio::test]
    async fn a_job_releases_download_before_waiting_for_compute() {
        let scheduler = PipelineScheduler::default();
        let cancel = CancellationToken::new();
        let compute = scheduler
            .acquire(
                ScheduledResource::Compute,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();

        let first_download = scheduler
            .acquire(
                ScheduledResource::Download,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();
        drop(first_download);

        let waiting_compute = scheduler.acquire(
            ScheduledResource::Compute,
            JobPriority::Background,
            &cancel,
            || {},
        );
        tokio::pin!(waiting_compute);
        assert!(tokio::time::timeout(SHORT_WAIT, &mut waiting_compute)
            .await
            .is_err());

        let d1 = scheduler
            .acquire(
                ScheduledResource::Download,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();
        let d2 = scheduler
            .acquire(
                ScheduledResource::Download,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();
        let d3 = scheduler
            .acquire(
                ScheduledResource::Download,
                JobPriority::Background,
                &cancel,
                || {},
            )
            .await
            .unwrap();

        drop((d1, d2, d3, compute));
        assert!(tokio::time::timeout(MUST_FINISH, &mut waiting_compute)
            .await
            .unwrap()
            .is_ok());
    }

    #[tokio::test]
    async fn wait_hook_runs_only_when_capacity_is_unavailable() {
        let scheduler = PipelineScheduler::default();
        let cancel = CancellationToken::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let immediate_calls = calls.clone();
        let held = scheduler
            .acquire(
                ScheduledResource::Compute,
                JobPriority::Background,
                &cancel,
                move || {
                    immediate_calls.fetch_add(1, Ordering::SeqCst);
                },
            )
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let waiting_calls = calls.clone();
        let waiting_cancel = CancellationToken::new();
        let waiting = scheduler.acquire(
            ScheduledResource::Compute,
            JobPriority::Background,
            &waiting_cancel,
            move || {
                waiting_calls.fetch_add(1, Ordering::SeqCst);
            },
        );
        tokio::pin!(waiting);
        assert!(tokio::time::timeout(SHORT_WAIT, &mut waiting)
            .await
            .is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        waiting_cancel.cancel();
        assert!(matches!(waiting.await, Err(AppError::Cancelled)));
        drop(held);
    }
}
