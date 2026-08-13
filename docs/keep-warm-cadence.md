# Backend keep-warm: cadence evidence

This documents why the old keep-warm mechanism didn't work, what replaced it, what was
actually measured, and what's still unverified.

## The old mechanism, and why it failed

`.github/workflows/keep-warm.yml` used to ping `/health` on a plain `schedule: '*/5 * * * *'`
GitHub Actions cron. Every run succeeded, so it looked healthy. It wasn't: GitHub Actions
schedules are explicitly best-effort and drift under load. Measured gaps between consecutive
"every 5 minutes" runs on this repo: **17.7 to 62.6 minutes, median 33.3** - regularly past
Render's 15-minute idle threshold, so the backend kept falling asleep between pings anyway.
Production cold start was measured at **26.8s** on the first request after a sleep, vs.
0.5-0.8s once warm.

## What Render's own docs say

- Spin-down: ["Render spins down a Free web service that goes 15 minutes without receiving
  any inbound traffic."](https://render.com/docs/free) (includes HTTP and WebSocket traffic)
- Free instance hours: **750 free instance-hours per workspace per month**. A spun-down
  service does not consume hours; a running one does. Hours are pooled across every free
  service in the same workspace and do not roll over.
- Self-pinging / keep-alive: Render's docs do not explicitly permit or prohibit pinging your
  own service to prevent it from spinning down. No statement either way was found in
  `render.com/docs/free` or the acceptable-use policy page.

**Consequence worth flagging explicitly:** a keep-warm mechanism that actually succeeds turns
the backend from "mostly asleep, effectively free" into "continuously running." A service kept
warm 24/7 for a full month burns roughly 720-744 of the workspace's 750 free instance-hours -
essentially the *entire* monthly budget, on one service. If any other free-tier service is ever
added to the same Render workspace, this keep-warm mechanism would leave it almost no headroom
and could cause it to be throttled or spun down involuntarily once the pool is exhausted before
month-end. This isn't a violation of anything Render states, but it is a real cost of "fixing"
sleep on the free plan that's easy to miss, since it isn't money.

## What replaced it, and why

[GitHub explicitly allows `workflow_dispatch` and `repository_dispatch` events created with the
built-in `GITHUB_TOKEN` to start a new workflow
run](https://github.blog/changelog/2022-09-08-github-actions-use-github_token-with-workflow_dispatch-and-repository_dispatch/).
That makes a self-relaunching job possible with no new secret, token, or third-party account:

- One job pings `/health` on a plain bash `sleep 240` loop for ~5h50m (under the
  [6-hour GitHub-hosted job cap](https://docs.github.com/en/actions/reference/limits)), then calls
  `gh workflow run keep-warm.yml` on itself before exiting.
- Cadence during the loop comes from wall-clock `sleep` in an already-running VM, not from the
  Actions scheduler, so it isn't subject to the queuing drift that broke the old cron.
- The `*/5` schedule stays on only as a backstop to restart the chain if it's ever broken (a run
  crashes before it re-triggers, a transient self-dispatch failure occurs, etc.), not as the
  primary cadence mechanism. A `concurrency: group: keep-warm` block coalesces redundant
  backstop firings to at most one pending run while the chain is healthy. The backstop cannot
  revive the workflow if GitHub disables it after 60 days of repository inactivity; a maintainer
  must re-enable the workflow first.

### Runtime safeguards and manual dispatches

- `loop_seconds` is a manual-test override for the current run only. Blank selects the 21,000s
  production duration; otherwise the value must be a positive integer no greater than 21,000.
  A self-triggered successor receives no override and therefore returns to the production
  duration.
- The job timeout is 355 minutes while the production loop is capped at 350 minutes, preserving
  five minutes for its summary and self-dispatch handoff. Near the loop deadline, both the final
  `curl` budget and the final sleep are limited by the remaining time so an iteration cannot
  consume that handoff margin.
- Individual ping failures are counted and do not stop later attempts. The ping step fails if no
  request succeeds, making a persistent outage visible, while the `if: always()` handoff still
  attempts to continue the chain.

### Options considered and not taken

- **Cloudflare Workers Cron Triggers** (free, and Cloudflare's cron scheduler is far more
  precise than GitHub Actions' - it doesn't share the same queuing-under-load problem) would
  likely be the more robust, simpler long-term fix: no CI job burning wall time, no self-chain
  state machine, just a small Worker on a native cron. It was **not** implemented here because
  it needs a new Cloudflare account and API token that this repository does not already have,
  and provisioning third-party accounts was out of scope for this change. Flagged separately for
  the captain to decide on.
- **External uptime pingers** (UptimeRobot, cron-job.org, etc.) have the same problem: all of
  them need a new third-party account this repo doesn't have credentials for.
- **Paid Render instance type** removes the idling behavior entirely, but changing the hosting
  plan was explicitly out of scope for this change - the captain is deliberately testing the
  free-tier lane.

## What was actually measured (this session, 2026-08-12)

Real `workflow_dispatch` runs of the new workflow were triggered on this branch (`fm/ehparkleh-keepwarm-r1`)
and observed directly via the GitHub Actions API. The workflow's `loop_seconds` input (added for
exactly this purpose) was used to shrink the loop so the *full* run-to-run handoff could be
observed within one session, without waiting out a real ~5h50m cycle:

| Event | Timestamp (UTC) | Delta |
|---|---|---|
| `workflow_dispatch` API call issued (run A) | 08:33:43 | - |
| Job A starts running (`started_at`) | 08:33:53 | +10s from dispatch |
| First `/health` ping logged `ping ok` | 08:34:27 | +34s from job start |
| Second `/health` ping logged `ping ok` | 08:38:27 | **+240.0s from the first** |
| ... (run A cancelled here; second run, `loop_seconds=20`, dispatched separately) | | |
| Run B job starts running | 08:46:07 | - |
| Run B ping logged `ping ok` | 08:46:08 | - |
| Run B loop exits, `gh workflow run keep-warm.yml` call made | 08:50:08 | +240s (one sleep cycle) |
| Run B completes with conclusion `success` | 08:50:15 | +7s |
| **Run C (the self-triggered continuation) appears, `in_progress`** | 08:50:1xish | **within seconds of run B finishing** |

The hosted observation preceded the final deadline hardening. In that version,
`loop_seconds=20` still allowed one full 240s sleep, which explains the four-minute Run B row.
The current workflow bounds that final sleep and the final `curl` budget to the requested
deadline and rejects unsafe override values; `scripts/test_keep_warm_workflow.py` is the focused
executable regression coverage for those invariants.

Takeaways, all measured directly rather than assumed:

- **Dispatch-to-running queue delay was ~10 seconds** on this public repo - far below anything
  that would threaten the 15-minute idle window.
- **The in-loop cadence was exactly 240.0s between consecutive pings**, matching the configured
  `sleep 240` precisely, confirmed on two separate runs - no observable drift, because the
  Actions scheduler isn't involved in that cadence at all once the job is running.
- **The full self-retrigger handoff was verified end-to-end**: a run's `gh workflow run
  keep-warm.yml` call succeeded and produced a new `in_progress` run within seconds. This also
  confirms the repo's `default_workflow_permissions: read` setting (checked via
  `gh api repos/.../actions/permissions/workflow`) does **not** block the workflow's own
  explicit `permissions: actions: write` grant - a real risk that was checked, not assumed.
- Cancelling a run does not break the chain, because the retrigger step uses `if: always()`: a
  cancelled run still hands off to its successor. This was discovered by testing (an early test
  run was cancelled and still spawned a continuation), and is a genuine resilience property of
  this design, not just a testing artifact - confirmed separately by disabling the workflow
  (`gh workflow disable`) before cancelling, which produced a clean, expected `HTTP 422: Cannot
  trigger a 'workflow_dispatch' on a disabled workflow` instead of an unwanted continuation.
- The test chain was cleaned up (workflow disabled just long enough to cancel the in-flight test
  run without it re-spawning, then re-enabled) so no test-duration jobs were left running past
  this session. Total production interruption from this testing: roughly two windows of ~1
  minute each while the workflow was briefly disabled.

## What remains unverified

- **A full ~5h50m production-duration cycle.** Everything above was verified using the
  `loop_seconds` override to compress the cycle; the mechanism was exercised end-to-end (queue
  delay, in-loop cadence, self-retrigger, permissions) but not for the full default duration.
  There's no reason to expect the cadence to behave differently over a longer run - the loop
  logic doesn't change - but it hasn't been directly observed.
- **Multi-day continuity.** Whether the chain keeps running indefinitely across many real
  cycles without a gap forming (e.g. from a transient `gh` CLI failure, a GitHub Actions outage,
  or the 60-day schedule-disable rule if the repo ever goes quiet) has not been observed past
  one session.

### How to check later

1. Open the repo's Actions tab, filter to the `Keep backend warm` workflow, and look at the
   `event` column over a multi-hour window. The running chain should consist of
   `workflow_dispatch` events; `schedule` backstop runs may appear queued or cancelled behind it
   because of the `keep-warm` concurrency group. A scheduled run taking over indicates that the
   prior chain stopped before its handoff.
2. Open a `workflow_dispatch`-triggered run and check its log for the `ping ok` lines - gaps
   between consecutive lines should stay at ~240s for the whole ~5h50m run.
3. Confirm the run's last step (`Re-trigger this workflow to continue the chain`) succeeds, and
   that a new run starts within roughly a minute of that run completing.
4. If gaps between runs ever exceed 15 minutes, that's the signal the mechanism has failed in
   the same way the old one did, and needs a different fix (Cloudflare Cron Triggers or a paid
   instance are the two realistic next steps - see above).
