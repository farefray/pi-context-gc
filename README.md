# @farefray/pi-context-gc

**Git release: `0.1.1-farefray.1`, for explicitly integrated pi-web hosts using exact unbundled Pi SDK 1.3.0 on Node.js. Stock Pi CLI is unsupported; the standard bundled CLI refuses readiness (`sdk-module-mismatch`). Installing the scheduler and backend alone does not supply the required host integration.**

A semantic compaction **scheduler**, not a compaction backend. The model calls `compact_context` at a completed phase boundary with a bounded task/decision/search/verification ledger. GC waits for the entire persisted tool batch, rechecks readiness, asks Pi to compact, then resumes once after success. Pi's normal threshold/overflow safeguards remain unchanged.

## Install from exact Git tags

These forks are distributed through GitHub, **not npm**. The initial release pair is pinned to the immutable Git tags below. Do not substitute an unversioned branch or `npm:@farefray/...`.

Fetch the reviewed sources for your integrated host:

```sh
git clone --branch v0.1.1-farefray.1 --single-branch https://github.com/farefray/pi-context-gc.git pi-context-gc
git clone --branch v0.7.4-farefray.1 --single-branch https://github.com/farefray/pi-better-compaction.git pi-better-compaction
```

For hosts using Pi's package manager, the equivalent exact source declarations are `git:github.com/farefray/pi-context-gc@v0.1.1-farefray.1` and `git:github.com/farefray/pi-better-compaction@v0.7.4-farefray.1`. For example:

```sh
pi install --local git:github.com/farefray/pi-context-gc@v0.1.1-farefray.1
pi install --local git:github.com/farefray/pi-better-compaction@v0.7.4-farefray.1
```

Those commands fetch/register packages; they do **not** integrate a host or make stock CLI native mode supported. A host-owned composition must load the factories exactly once instead of also autoloading both default entries. Review source before granting project trust. Record the resolved tag commits and the host's locked SDK/runtime versions for a reproducible deployment; do not move release tags.

## Composition and host requirements

The manifest has one extension, `index.ts`. No vendored backend, Toolkit, provider, credentials or host patches are included. Install the [separate backend](https://github.com/farefray/pi-better-compaction/blob/v0.7.4-farefray.1/README.md) and load exactly one producer/reader for its checkpoint format. Its own compatibility and refusal policy apply; the scheduler's fake-backend tests alone do **not** certify it.

Native mode requires an explicitly integrated pi-web host providing **`compactionSession` v1 and a complete qualified handler profile**, not just the two installed packages. **No publicly distributed ready-to-use pi-web host implementation is currently provided.** Integrators must implement and qualify that adapter themselves. The public backend documents the full [host capability contract](https://github.com/farefray/pi-better-compaction/blob/v0.7.4-farefray.1/README.md#host-capability-version-1) and a [minimal structural composition sketch](https://github.com/farefray/pi-better-compaction/blob/v0.7.4-farefray.1/README.md#minimal-structural-composition); neither is a standalone host.

Use host-supplied SDK/AI/agent-core **1.3.0**, not merely a compatible semver range. Node is the supported delivery runtime; Bun source-test success is not qualification for Bun delivery.

For scheduler-only offline/local evaluation, the verified **unbundled** SDK entrypoint is:

```sh
node /path/to/pi-coding-agent/dist/cli.js -e /path/to/pi-context-gc
```

Use `-e /path/to/pi-context-gc/scheduler-only.ts` as an equivalent explicit alias. This is a scheduler test route, **not** an end-to-end native install recipe or stock CLI support. Do not use `dist/bundle/cli.js` for semantic GC: it is tested to refuse. Scheduler readiness needs no SDK fork or private host hook; the backend's native operations still require the separate host capability above. Node.js must support synchronous native `require(ESM)` (package minimum 22.19.0; offline qualification used Node 24.19.0).

Host-provided SDK/typebox packages are peers, not runtime dependencies. Do not install a second SDK to work around an identity refusal. Runtime imports go through Pi's module mapping; the adapter then verifies exact package version and `SettingsManager` identity before loading that same unbundled SDK's internal pure `prepareCompaction`. Unknown versions, foreign copies, asset overrides, stale contexts or malformed state refuse without aborting/compacting. Preparation is not copied and readiness is not inferred from token estimates or `force`.

## Safety and recovery

- `compact_context` is sequential and model-only, not callable from codemode.
- Short/ineligible contexts refuse before acceptance. Current settings, model overrides, session and branch are checked again before start/retry.
- Acceptance is intent only: all sibling results must be complete **and persisted** before compaction.
- Queued user input, Stop, tree changes, session replacement and stale callbacks invalidate unsafe work.
- A context-time refusal pauses in memory immediately without appending to the active request's session leaf. Its diagnostic is persisted once at an idle `agent_settled` boundary, only while the same session/checkpoint/generation remains current. Unknown idle/session state cannot authorize a write; invalidation or navigation discards stale diagnostics. Idle manual retry refusals can record immediately. Settlement never starts compaction, retry or continuation.
- Successful continuation carries the full canonical ledger exactly once. Total failure pauses by default and never claims a successful checkpoint.
- `/context-gc status | retry | resume | cancel` inspects or recovers. Explicit `resume` can continue without successful compaction; the ledger states that truthfully.
- No user-history migration is provided. Reader compatibility belongs to the separately installed backend; start a new session when its format is unsupported.

## Configuration

Global: `~/.pi/agent/context-gc.json`. Trusted project override: `.pi/context-gc.json`. No project config is read before trust.

```json
{
  "enabled": true,
  "autoResume": true,
  "resumeOnFailure": false,
  "notify": false,
  "minContextTokens": 0
}
```

The public package default is `minContextTokens: 0`; a host project's admission policy is separate and is not shipped here. Zero disables only the additional token floor, **not** exact SDK readiness or any safety guard. A positive safe-integer floor requires known current SDK usage at acceptance and start/retry. Early model guidance is stable and never embeds a changing usage counter. Pi's `keepRecentTokens` and effective per-model settings still determine preparation eligibility.

Boolean environment overrides: `PI_CONTEXT_GC_ENABLED`, `PI_CONTEXT_GC_AUTO_RESUME`, `PI_CONTEXT_GC_RESUME_ON_FAILURE`, `PI_CONTEXT_GC_NOTIFY` (`1/0`, `true/false`, `yes/no`, `on/off`).

## Embedding

`createContextGcExtension()` can be registered as a scheduler factory on its own; this does not supply a native backend or qualify stock CLI. Its optional admission callbacks (`admitSession`, `isActive`) remain activation-local and cannot grant SDK eligibility. `loadConfig(ctx)` exposes the same config reader for admission consumers.

`readCompactionReadiness(ctx, pi.getSettings())` returns `{ ok: true, eligible, sessionId, leafId }` or `{ ok: false, reason }`. `checkCompactionEligibility(pi, ctx)` returns a content-free eligible/refused result after validating the current snapshot and branch. Neither function grants project trust, dispatches a model, aborts a run or performs compaction.

## Verification and provenance

```sh
npm ci --ignore-scripts
npm run check
```

The latest maintainer recheck reports **410 scheduler tests passing**. Coverage includes inherited lifecycle/policy/batch guards, exact SDK readiness, effective settings, malformed/stale/foreign SDK refusals, and real unbundled CLI/Jiti with synthetic inference and an independent preparation oracle. The bundled CLI regression asserts refusal. Set `GC_HOST_SDK` to another exact installed SDK1.3.0 package directory to run CLI tests against the actual host rather than the dev installation. CLI fixtures use isolated HOME and synthetic in-memory sessions with network guards.

Separate checks report backend **212 unit + 23 actual-SDK oracle + 3 full-root loader** checks, host source/packed composition **26**, and compiled-adapter fixture **1** passing. These are offline, scoped checks, not public Git installation verification, full compiled RPC/package composition, native browser acceptance, live memory-quality evidence or blanket cross-provider certification. Node delivery is qualified within those scopes; Bun delivery is not. Publication and host activation remain separate actions.

`docs/` and `CHANGELOG.md` retain upstream historical research/validation, including the earlier vendored composition; they are **not** the current install or support contract. This README and [PATCHES.md](PATCHES.md) describe this fork. Original author: [Manuel Cecchetto](https://github.com/manuelcecchetto/pi-context-gc). MIT license and third-party notices are preserved in [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
