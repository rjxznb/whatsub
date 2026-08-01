# Pipeline Scheduler Design

## Problem

whatSub currently treats the download queue as a progress display rather than a
resource scheduler. Every distinct `import_video` invocation can enter yt-dlp,
ffmpeg, and whisper-cli independently. The existing `ImportState` fence only
rejects a second job for the same video ID; it does not bound work across
different videos.

This allows manual imports, background imports, AI-tool imports, cloud import
queue work, and retranscription to overlap. On lower-spec machines, multiple
whisper-cli processes can each load a model into GPU or system memory while
ffmpeg processes compete for CPU and disk bandwidth. The result can be severe
UI stalls, memory pressure, GPU failures, and operating-system swapping.

## Goals

- Limit URL download work to three concurrent jobs.
- Limit long-running ffmpeg/Whisper compute work to one concurrent job.
- Give foreground work priority over queued background work without preempting
  jobs that have already started.
- Preserve FIFO ordering within one priority level.
- Apply the limits to every desktop entry point, including manual imports,
  background imports, AI tools, cloud queue imports, local files, and explicit
  retranscription.
- Allow cancellation while a job is waiting, without spawning a child process.
- Show whether a job is waiting for download capacity or compute capacity.
- Keep the limits automatic; do not add a user-facing setting.

## Non-goals

- Do not limit DeepSeek or other LLM analysis requests in this change.
- Do not persist the in-memory scheduler queue across an application process
  restart.
- Do not preempt or pause a running yt-dlp, ffmpeg, or whisper-cli process to
  make room for a foreground job.
- Do not change yt-dlp's retry, resume, format-selection, or cookie behavior.
- Do not replace the existing same-video cancellation and cleanup fence.

## Chosen Architecture

Add a single Tauri-managed Rust `PipelineScheduler`. Scheduling belongs in the
backend because every import path eventually invokes a Rust command, whereas a
frontend-only queue can be bypassed by another component or command caller.

The scheduler owns two independent, priority-aware resource pools:

| Pool | Capacity | Work covered |
|---|---:|---|
| Download | 3 | URL import's complete yt-dlp phase, including yt-dlp's own short ffmpeg merge |
| Compute | 1 | Local-file compatibility conversion, audio extraction, Whisper transcription, and explicit retranscription |

Each pool has foreground and background wait queues. A released slot selects
the oldest foreground waiter first; if none exists, it selects the oldest
background waiter. Running jobs retain their slots until their current stage
finishes, fails, or is cancelled.

The scheduler returns an owned permit whose `Drop` implementation releases the
slot. This makes normal success, early errors, and panic-safe unwinding release
capacity through the same mechanism.

## Priority Definition

The existing `ImportRequest.background` field determines priority:

- `background == false`: foreground priority
- `background == true`: background priority

Explicit player retranscription is foreground unless the caller is the
existing background retranscribe-and-analyze path. That command will receive an
explicit background argument so its priority does not depend on which frontend
function happened to invoke it.

Priority affects only waiters. If three background downloads are already
running, a new foreground download waits until one finishes; it then starts
before any background job that is still queued.

## Stage Flow

### URL import

1. Register the existing same-video cancellation fence.
2. Emit `Started` so the job appears immediately.
3. Wait for a download permit using the request's priority.
4. Run yt-dlp while holding the download permit.
5. Release the download permit immediately after yt-dlp and thumbnail work.
6. Wait for a compute permit.
7. Extract audio and run Whisper while holding the compute permit.
8. Release the compute permit and finish the existing pipeline.

The job never holds both permits at once. Consequently, completed downloads do
not consume download capacity while waiting for Whisper.

### Local-file import

1. Register the same-video fence and emit `Started`.
2. Wait for a compute permit.
3. Perform compatibility remux/transcode, thumbnail generation, audio
   extraction, and Whisper transcription while holding that permit.
4. Release it when the compute phase completes.

Small ffprobe calls may remain inside the compute permit. They are short and
keeping the local-media stage together avoids another scheduling boundary.

### Retranscription

1. Register the existing retranscription fence.
2. Wait for a compute permit using the caller's explicit priority.
3. Extract audio if required and run Whisper.
4. Release the permit before LLM analysis begins.

### LLM analysis

Analysis begins after transcription as it does today and does not consume a
download or compute permit. Its concurrency remains unchanged in this scope.

## Cancellation

Permit acquisition must race the existing `CancellationToken` instead of
blindly awaiting queue admission. If cancellation wins:

- remove or invalidate the waiter;
- return `AppError::Cancelled`;
- do not launch yt-dlp, ffmpeg, or whisper-cli;
- continue through the existing completion-aware cleanup path.

A cancelled waiter must be skipped safely even if a permit release and
cancellation happen at nearly the same time. Granting a permit is represented
by a one-shot response; the scheduler reclaims the slot if the receiver has
already disappeared.

Running jobs continue to use the current child-process cancellation path. The
scheduler does not add a second subprocess-kill mechanism.

## Progress Events and UI

Extend `PipelineEvent` with a waiting event containing:

- `video_id`
- `resource`: `download` or `compute`

The event is emitted only when acquisition cannot complete immediately. The
download queue store maps it to two visible phases:

- `等待下载…`
- `等待转录…`

The first implementation does not display an exact queue position. Priority
insertions and cancellations make a continuously accurate “前面 N 个” value
easy to misrepresent. The stage label gives the user the actionable reason for
the wait without promising a stable position.

Foreground imports show the same waiting labels inside `ImportModal`; background
imports show them in `DownloadQueueWidget`.

## Failure Handling

- Permit acquisition failure caused by application shutdown returns a clear
  scheduler-unavailable error rather than starting unbounded work.
- Errors from yt-dlp, ffmpeg, or Whisper retain their current classification
  and user guidance.
- Every acquired permit is released on success, classified failure, user
  cancellation, and cleanup failure.
- The existing same-video fence remains authoritative for duplicate and cleanup
  races; the scheduler controls capacity only.

## Testing

### Rust scheduler tests

- The first three download jobs start; the fourth waits.
- Releasing any download permit admits the next eligible waiter.
- Only one compute job starts at a time.
- Foreground waiters are chosen before queued background waiters.
- FIFO order is preserved within foreground and background priority classes.
- A foreground arrival does not interrupt a running background job.
- Cancelling a waiter prevents it from starting and does not leak capacity.
- Dropping a permit after success or error admits the next waiter.
- Download and compute pools are independent.

### Pipeline integration tests

- URL imports release the download permit before requesting compute capacity.
- Local imports never consume a download permit.
- Retranscription consumes compute capacity.
- Manual, background, AI-tool, and cloud-queue request shapes map to the correct
  priority.
- Existing same-video rejection and cancellation-cleanup tests remain green.

### Frontend tests

- Waiting-download and waiting-compute events render the expected labels.
- A later running-stage event replaces the waiting label.
- Cancelling a queued background item invokes the existing cancellation command
  and removes it only after backend confirmation.

## Acceptance Criteria

- At no time can one whatSub process run more than three URL download stages.
- At no time can one whatSub process run more than one scheduled ffmpeg/Whisper
  compute stage.
- A foreground waiter is selected before older background waiters when the next
  slot becomes free.
- Different import entry points cannot bypass the limits.
- Cancelling queued work starts no child process and leaks no permit.
- Users can distinguish waiting for download capacity from waiting for
  transcription capacity.
- Existing imports, retries, resume behavior, and same-video cancellation remain
  compatible.
