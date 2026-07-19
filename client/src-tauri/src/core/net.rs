//! Cheap "can we actually reach YouTube?" probe.
//!
//! Why this exists: on a mainland network with the proxy off, yt-dlp doesn't
//! fail fast — it hangs until our own 45s ceiling fires. The AI agent then
//! feeds that raw error back to the LLM, which retries with a different query,
//! hangs another 45s, and so on up to the per-turn tool cap: the user waits
//! minutes and only THEN hears "网络有问题", never "你没开梯子".
//!
//! A ~2s HEAD-ish request answers the same question up front, so the tool can
//! bail immediately with an actionable message. It deliberately routes through
//! the SAME proxy resolution yt-dlp uses (`core::proxy`), otherwise a working
//! Clash setup would look unreachable (or vice-versa) and we'd diagnose the
//! wrong thing.

use std::time::Duration;

/// YouTube's own connectivity endpoint: returns 204 with an empty body, so the
/// probe costs almost nothing. Hitting youtube.com itself (rather than a
/// generic captive-portal check) is the point — it's exactly the host yt-dlp
/// needs, so a network that blocks only YouTube is still reported correctly.
const PROBE_URL: &str = "https://www.youtube.com/generate_204";

/// Generous on purpose. The probe RACES the real search (it never gates it),
/// so a long timeout costs the happy path nothing — while a short one is
/// actively dangerous: a false "unreachable" would abort a search that was
/// working. Measured through a healthy Clash proxy, a cold request here took
/// 2.84s (TLS + proxy CONNECT from scratch); 2s would have mis-reported that
/// as "no VPN". 8s leaves room for a slow node and still beats the 45s search
/// ceiling by a wide margin.
const PROBE_TIMEOUT_SECS: u64 = 8;

/// True when YouTube answered at all (any HTTP status counts — we're testing
/// reachability, not the response).
///
/// **Fails OPEN**: if the probe itself can't run (client build failure), we
/// return `true` so a broken probe can never block a search that would have
/// worked. Only a definitive request failure reports `false`.
pub async fn youtube_reachable() -> bool {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(PROBE_TIMEOUT_SECS));
    if let Some(proxy) = crate::core::proxy::resolve_yt_dlp_proxy() {
        if let Ok(p) = reqwest::Proxy::all(&proxy) {
            builder = builder.proxy(p);
        }
    }
    let Ok(client) = builder.build() else {
        return true; // can't probe → don't stand in the way
    };
    client.get(PROBE_URL).send().await.is_ok()
}

/// Run `work`, aborting early only if `probe` reports the network unreachable.
///
/// `Ok(v)` = the work finished normally; `Err(())` = the probe says there's no
/// route to YouTube, so whatever `work` was doing could only have hung. When
/// the probe says "reachable" it parks on `pending()` forever and `work` is
/// left completely undisturbed — that's what makes this free on the happy path
/// (as opposed to gating the work behind the probe, which would tax every
/// successful call with the probe's latency).
///
/// Dropping `work` on the abort path is the caller's cancellation hook: for a
/// spawned child with `kill_on_drop(true)`, that reaps the process.
pub async fn race_with_reachability<T, W, P>(work: W, probe: P) -> Result<T, ()>
where
    W: std::future::Future<Output = T>,
    P: std::future::Future<Output = bool>,
{
    tokio::select! {
        res = work => Ok(res),
        () = async { if probe.await { std::future::pending::<()>().await } } => Err(()),
    }
}

/// The message shown when the probe says YouTube is unreachable.
///
/// The trailing directive matters: `runtime.ts` hands tool errors to the LLM
/// verbatim, and without being told to stop it will "helpfully" retry the
/// search with a reworded query — which is what turned one failure into a
/// multi-minute stall. Nothing the model can do fixes an off proxy, so the
/// only useful action is to tell the user.
pub fn unreachable_message() -> String {
    "无法连接 YouTube（网络不通）。最常见的原因是没有开梯子，或者梯子开了但没有生效 \
     （代理软件未开启系统代理 / 刚切换过节点）。请先开启科学上网工具，确认浏览器能打开 \
     youtube.com，然后再让我重新搜索。\n\n\
     [给助手的说明] 这是网络环境问题，重试本工具不会成功。不要再次调用搜索或下载工具，\
     直接把上面的情况告诉用户。"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreachable_message_names_the_likely_cause() {
        let m = unreachable_message();
        assert!(m.contains("梯子"), "must name the usual cause up front");
        assert!(m.contains("youtube.com"), "must give a concrete way to verify");
    }

    #[test]
    fn unreachable_message_tells_the_agent_not_to_retry() {
        // Without this the LLM re-searches and the user waits minutes.
        let m = unreachable_message();
        assert!(m.contains("不要再次调用"));
        assert!(m.contains("重试本工具不会成功"));
    }

    // The select! shape below is load-bearing: if the "reachable" arm didn't
    // park forever, EVERY search would abort the moment the probe answered.

    #[tokio::test]
    async fn reachable_probe_leaves_the_work_alone() {
        // Probe answers immediately and positively; the slower work must still
        // win and deliver its value.
        let work = async {
            tokio::time::sleep(Duration::from_millis(60)).await;
            "search results"
        };
        let got = race_with_reachability(work, async { true }).await;
        assert_eq!(got, Ok("search results"));
    }

    #[tokio::test]
    async fn unreachable_probe_aborts_the_work_early() {
        // Work would take "forever" (the 45s yt-dlp hang); the probe cuts it.
        let work = async {
            tokio::time::sleep(Duration::from_secs(45)).await;
            "never gets here"
        };
        let got = race_with_reachability(work, async { false }).await;
        assert_eq!(got, Err(()));
    }

    #[tokio::test]
    async fn work_that_finishes_first_wins_even_when_unreachable() {
        // A search that already succeeded must not be discarded just because a
        // slow probe later reports trouble.
        let work = async { "results" };
        let probe = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            false
        };
        assert_eq!(race_with_reachability(work, probe).await, Ok("results"));
    }
}
