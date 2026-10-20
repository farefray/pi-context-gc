# Fork changes

Package: `@farefray/pi-context-gc@0.1.1-farefray.1`.
Initial Git release: `farefray/pi-context-gc`, immutable tag `v0.1.1-farefray.1`; no npm release. See [README.md](README.md) for exact Git installation and integration requirements.
Upstream: `manuelcecchetto/pi-context-gc`, base `be0c2830b3914c4b1f314baa9fff4a55409d31dd`.
Original author/license/notices retained; repository metadata identifies `farefray`.

## Scheduler port

Selectively ported the reviewed scheduler kernel and its regression suite, without importing downstream Git history, deployment configuration or QA artifacts. Preserved complete persisted tool-batch validation, exactly-once truthful continuation, queue/Stop/session/tree/generation guards, activation-local optional admission, current minimum checks and stable early guidance. Reusable `minContextTokens` remains zero.

The package now declares only `index.ts`. Removed the old bundled backend from source and delivery; no Toolkit import or backend dependency is added. Use a separately installed backend such as `@farefray/pi-better-compaction`, subject to that package's own qualification and format guards.

## Pause diagnostic timing correction

Context-boundary refusals now update failed state/status immediately but defer the failed diagnostic entry until the existing `agent_settled` hook observes idle in the same current session/checkpoint/generation. This avoids changing the session leaf inside an active context/request pass. Reset, invalidation, cancellation, navigation and session replacement discard obsolete pending diagnostics; idle manual retry refusals retain immediate recording. The flush is diagnostic-only, best-effort and consumed once: no timer, retry, compaction or resume is added. Unknown idle/session inspection never authorizes persistence.

Focused runtime/extension regressions cover deferred recording, once-only idle settlement, stale lifecycle/session/generation rejection, unknown idle refusal and retained idle retry semantics. Existing minimum/readiness, persisted-batch, admission and continuation assertions remain; only active-context failed-ledger expectations move to the safe idle boundary. Host integration qualification remains separate; no host guard, backend, setting or SDK was changed.

## Exact SDK readiness

Replaced the deployment-specific host bridge with a package-internal adapter for **exact unbundled SDK1.3.0**. Host-mapped root imports plus native `require(ESM)` enforce package name/version and `SettingsManager` identity. The adapter invokes the actual pure internal `prepareCompaction` on the current canonical branch and effective per-model settings. It checks guarded context/session/leaf identity before and after preparation. No copied preparation, force hint, token heuristic, global registry or prototype patch is used.

Exports `readCompactionReadiness` and `checkCompactionEligibility` for read-only admission consumers, retaining `createContextGcExtension` and optional admission callbacks. Deterministic tests use explicit injected readers/loaders; production needs no host hook.

## Qualification and support boundary

Offline checks use exact SDK1.3.0 declarations, inherited kernel assertions, refusal regressions, and actual CLI/Jiti loading with synthetic inference/backend and an independently loaded preparation oracle. The default standalone factory compacts and resumes once on the verified unbundled route.

**The target is explicitly integrated pi-web hosts, not the standard packaged/bundled CLI.** That CLI refuses identity mismatch; its embedded preparation is not exported, and no SDK change or relaxed identity is included. This documented support boundary no longer blocks the pi-web target. Node scheduler delivery has offline coverage. The latest maintainer recheck reports 410 scheduler tests, backend 212 unit + 23 SDK oracle + 3 loader checks, host source/packed composition 26 and compiled-adapter fixture 1 passing. These scopes do not establish public Git reachability, another host's integration, full compiled RPC/package composition, native browser behavior or live provider/quality qualification. A successful refusal test is not stock CLI support. SDK0.84 and other SDK versions, and Bun delivery, are not qualified.

Native operation requires a host-provided `compactionSession` v1 and complete qualified handler composition. No publicly distributed ready-to-use pi-web host implementation is currently provided; installing the pair alone is insufficient. The public backend owns the structural contract. No host implementation or project policy is included here.

Historical upstream `docs/` and `CHANGELOG.md` remain provenance, not current installation instructions. The README owns the current fork contract.
