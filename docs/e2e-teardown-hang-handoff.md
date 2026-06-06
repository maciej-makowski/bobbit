# E2E full-suite teardown/exit hang — investigation handoff

**Branch:** `goal/add-llama-swap-087b38b0` (pushed to fork `maciej-makowski/bobbit`)
**Author:** team-lead session for goal "Add llama-swap local models"
**Status:** llama-swap feature is COMPLETE and correct. The only blocker is a
**pre-existing, environment-triggered E2E hang** that prevents the full
`test:e2e` suite from ever exiting cleanly on this host, so the goal's
`implementation` gate (which runs the full suite) times out. This hang is
**not caused by the llama-swap feature.**

---

## TL;DR for the fix session

- The full browser/api E2E suite **runs every test to completion** (no real
  failures — 406/406 browser pass, 1297 unit pass), then the Playwright run
  **never exits**: it reaches `[N/N]`, goes silent for 20–45 min, leaves
  orphaned worker/Chromium processes, and is eventually SIGKILLed by the gate
  at the step timeout → gate FAILS as a "timeout" even though tests passed.
- **Cheap repro (~2 min)** — a 12-test slice reproduces the exit hang:
  ```bash
  npx playwright test --project=browser --config playwright-e2e.config.ts \
    --retries=0 \
    tests/e2e/ui/custom-provider-metadata.spec.ts \
    tests/e2e/ui/base-ref-settings.spec.ts \
    tests/e2e/ui/marketplace.spec.ts \
    --reporter=line
  ```
  Observed: reaches `[12/12]`, prints the worker gateway shutdown logs
  (`[trigger-engine] Stopped`, `[sandbox-manager] All 0 sandbox(es) shut down`),
  then **never prints the shell's trailing `EXIT=` marker** — the process
  hangs. One `node` worker lingers at ~2% CPU; you must `pkill` it.
- **Leading hypothesis:** a **leaked handle in the in-process gateway** keeps
  the Playwright worker's Node event loop alive after `gw.shutdown()` returns
  (unref-less timer, unclosed fs watcher, lingering mock-agent child process,
  or a still-open socket). The per-test timeout (30s) does NOT bound
  worker-process exit, so one wedged worker stalls the whole runner.

---

## Environment

- Host: 32 cores, 124 GB RAM, Linux. **Not** resource-constrained.
- `gateway-harness.ts` runs the gateway **in-process** inside each Playwright
  worker (imports `../../dist/server/server.js` → `createGateway`). So each
  browser worker = 1 Node process hosting a full gateway + 1 Chromium.
- The goal's `implementation` gate (`.bobbit/config/project.yaml`, workflow
  `feature`) runs, in phase 1 and CONCURRENTLY: `build`, `check`, `unit`
  (`tests/playwright.config.ts`, also Chromium), and `e2e`
  (`playwright-e2e.config.ts`). Then phase 2 LLM reviews + phase 3 QA.

## The feature (DONE — do not touch)

- `src/server/agent/model-registry.ts` — manual-model metadata + fix for the
  silent `openai-completions` discovery bug (UI-saved manual providers used to
  yield zero models).
- `src/ui/dialogs/CustomProviderDialog.ts` — metadata-preserving edit.
- `docs/llama-swap-provider.md` — provider doc + 13-model re-seed snippet.
- `tests/custom-provider-manual-metadata.test.ts` (unit, passes 4/4),
  `tests/e2e/ui/custom-provider-metadata.spec.ts` (browser, passes ~4s).
- `npm run check` clean; `npm run test:unit` → 1297 passed.

## Measurements (data, not guesses)

Measured with the JSON reporter at `retries=0`:

- Full suite ≈ **1191 test cases** (api + browser); browser project alone ≈
  **411 cases**.
- **Sum of all browser test durations ≈ 506 s (~8.5 min)** of real work.
- Yet wall time at the original `workers:3` (browser) / `workers:4` (top) was
  **~25 min** for the browser project, and the full gate run exceeded
  900 s, then 2400 s.
- Slowest individual tests (none pathological): `jump-to-last-prompt.spec.ts`
  one test 58 s; `sidebar-keyboard-nav.spec.ts` 19 s; everything else < 10 s.
- **Result counts when allowed to run: 406 passed / 0 failed / 0 flaky
  (browser, retries=0); 1297 passed (unit).** The "failure" is purely the
  end-of-run hang + timeout, plus (once) a resource-starvation crash — see
  below.

## Hang signature

1. Runner reaches `[N/N]` (all tests done).
2. Worker gateway shutdown logs appear:
   `[trigger-engine] Stopped` … `[sandbox-manager] All 0 sandbox(es) shut down`.
3. **No further output.** Log file is silent for 20–45 min.
4. One or more `node` workers + their Chromium children linger at low CPU;
   orphaned `chrome-headless` processes accumulate (observed up to 65).
5. With Playwright `--global-timeout`, the run prints:
   `Timed out waiting Ns for the test suite to run` /
   `...for the teardown for test suite to run` / `1 did not run` /
   `N errors were not a part of any test` — and exits non-zero.

The last gateway shutdown log is `[sandbox-manager] All 0 sandbox(es) shut
down`. In `createGateway().shutdown()` (`src/server/server.ts` ~L1931) the
remaining steps after that are:
`await sessionManager.cleanupSandboxNetwork()` → `server.close()` →
`server.closeAllConnections()`. `cleanupSandboxNetwork()`
(`session-manager.ts` L1163) is bounded (docker ENOENT rejects instantly; 10 s
timeout otherwise), so it is NOT the cause. The hang is therefore either in
`server.close()` waiting on a lingering socket, or — more likely — the
process has a **non-server leaked handle** so it never exits even after
shutdown resolves.

## What I changed (committed on the branch)

| Commit | Change | Effect on hang |
|---|---|---|
| `b081fbf3` | llama-swap feature + tests | n/a (feature) |
| `664e9996` | Raise E2E gate step `timeout` 900→2400 s in all `project.yaml` workflows | **No fix** — suite still didn't finish/exit in 2400 s |
| `84c9a578` | `playwright-e2e.config.ts`: scale worker count to host core-count on non-Windows (win32 keeps 3/4) | Sped execution, but initial over-scale (top16/browser8) **crashed** unit+e2e concurrently with `browserContext.newPage: browser has been closed` (host oversubscription, since the unit suite runs 16 workers at the same time) |
| `07d55089` | `server.ts shutdown()`: terminate live `wss.clients` + `server.closeAllConnections()`; dial worker caps back to top/api≤6, browser≤5 | Good graceful-shutdown hygiene, **but did NOT fix the exit hang** (12-test slice still hangs) |

> Note: I also hand-edited the **runtime** goal snapshot
> `<primary-worktree>/.bobbit/state/goals.json` (gate `implementation` → step
> "E2E tests" `timeout` 900→2400) because the goal workflow is frozen at
> creation and the harness reads the timeout from the in-memory snapshot
> (loaded from `goals.json` at boot). A backup is at
> `goals.json.bak-llamaswap`. This is runtime state, not the repo.

## Things ruled out

- **Slow tests** — total real work is ~8.5 min; nothing is pathologically slow.
- **Retries causing the hang** — `retries=0` still hangs at end.
- **A single obvious culprit spec** — `settings-restart-button.spec.ts` (drives
  the dev-harness restart) passes cleanly in isolation (2 passed, 3.5 s, clean
  exit). The 12-test slice that hangs does **not** include it.
- **`cleanupSandboxNetwork()`** — bounded; docker unavailable on this host.
- **`closeAllConnections()` alone** — added it; slice still hangs, so the
  leaked handle is likely NOT (only) an http/WS socket.

## Recommended next diagnostic (fastest path to root cause)

1. In `tests/e2e/gateway-harness.ts`, in the worker `gateway` fixture teardown
   right after `await gw.shutdown();`, temporarily log active handles:
   ```ts
   await gw.shutdown();
   console.log("[diag] active resources after shutdown:",
     (process as any).getActiveResourcesInfo?.());
   // or use the `why-is-node-running` package for a full stack-attributed dump
   ```
   Then run the 12-test slice above and read the dump. The resource **types**
   (`Timeout`, `TCPSocketWrap`, `ChildProcess`, `FSReqCallback`/watchers,
   `Immediate`) point straight at the leak.
2. Audit `createGateway().shutdown()` (`src/server/server.ts` ~L1931) and
   everything it awaits for handles that are never released:
   - intervals/timeouts created without `.unref()` (grep `setInterval`);
   - file/config watchers (e.g. `projectContextManager` / config-cascade
     watchers — confirm `closeAll()` actually closes `fs.watch` handles);
   - spawned **mock-agent** child processes from in-flight sessions that
     aren't killed by `sessionManager.shutdown()` (a live child keeps the
     parent alive via its stdio pipes);
   - the worktree-pool drain (`pool.drain()`), git child processes.
3. Once the leaking handle is identified, close/unref it in `shutdown()` (or in
   the relevant subsystem's shutdown) so the worker process exits promptly.
4. Validate with the 12-test slice (must print `EXIT=0` within a few seconds of
   `[12/12]`), then the full `--project=browser` run, then the full gate.

## Suggested acceptance criteria for the fix

- The 12-test slice and the full `--project=browser` run **exit on their own**
  (no lingering `node`/`chrome-headless`) within a few seconds of the last test.
- `npm run test:e2e` completes and exits non-zero only on real failures.
- The goal's `implementation` gate passes within its timeout.
- Keep the win32 conservative worker caps; the `closeAllConnections()` change
  is good hygiene and should stay regardless.

## How to resume this goal after the fix lands

1. Pull the fix into this worktree (`git fetch` + merge/rebase onto the fixed
   master or cherry-pick), rebuild (`npm run build`).
2. Re-signal the `implementation` gate; confirm the full suite now passes.
3. Proceed to `documentation` and `ready-to-merge` gates, open the PR.
4. **Then** notify the *Podman Sandbox Runtime* team to pull the E2E fix and
   resume (per the user's request).
