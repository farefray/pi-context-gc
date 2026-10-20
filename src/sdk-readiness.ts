import { getPackageDir, SettingsManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const SDK_NAME = "@earendil-works/pi-coding-agent";
const SDK_VERSION = "1.3.0";
type Settings = ReturnType<SettingsManager["getCompactionSettings"]>;
type Prepare = (entries: SessionEntry[], settings: Settings) => unknown;

export type CompactionReadiness =
  | { ok: true; eligible: boolean; reason?: string; sessionId: string; leafId: string | null }
  | { ok: false; reason: string };
export type CompactionReadinessReader = (ctx: ExtensionContext, settings: unknown) => CompactionReadiness;

/** Internal file/module seam for deterministic refusal tests; never a host hook. */
export interface SdkLoader {
  getPackageDir(): string;
  readManifest(path: string): unknown;
  requireModule(path: string): unknown;
}

// Do not let Jiti package aliases or a bundler rewrite native require(ESM).
// The root import above MUST use the host's supplied SDK mapping.
const nativeLoader: SdkLoader = {
  getPackageDir: () => realpathSync(getPackageDir()),
  readManifest: (path) => JSON.parse(readFileSync(path, "utf8")),
  requireModule: (path) => process.getBuiltinModule("node:module").createRequire(import.meta.url)(path),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadPreparation(loader: SdkLoader): { ok: true; prepare: Prepare } | { ok: false; reason: string } {
  if (process.env.PI_PACKAGE_DIR) return { ok: false, reason: "sdk-package-override" };
  try {
    const dir = loader.getPackageDir();
    const manifest = loader.readManifest(join(dir, "package.json"));
    if (!isRecord(manifest) || manifest.name !== SDK_NAME || manifest.version !== SDK_VERSION) {
      return { ok: false, reason: "sdk-version-mismatch" };
    }
    const settings = loader.requireModule(join(dir, "dist/core/settings-manager.js"));
    if (!isRecord(settings) || settings.SettingsManager !== SettingsManager) {
      // Includes the SDK1.3 bundled CLI: its embedded class is not the disk class.
      return { ok: false, reason: "sdk-module-mismatch" };
    }
    const compaction = loader.requireModule(join(dir, "dist/core/compaction/compaction.js"));
    if (!isRecord(compaction) || typeof compaction.prepareCompaction !== "function") {
      return { ok: false, reason: "sdk-prepare-unavailable" };
    }
    return { ok: true, prepare: compaction.prepareCompaction as Prepare };
  } catch {
    return { ok: false, reason: "sdk-sync-load-failed" };
  }
}

/** Build a reader with an explicit loader seam for tests. No global installation or mutation. */
export function createCompactionReadinessReader(loader: SdkLoader = nativeLoader): CompactionReadinessReader {
  return (ctx, settings) => {
    try {
      // SDK1.3's own getter asserts that this context has not been replaced/reloaded.
      const getCwd = Object.getOwnPropertyDescriptor(ctx, "cwd")?.get;
      if (typeof getCwd !== "function") return { ok: false, reason: "context-guard-unavailable" };
      try { getCwd.call(ctx); } catch { return { ok: false, reason: "context-stale" }; }
      if (!isRecord(settings) || ![Object.prototype, null].includes(Object.getPrototypeOf(settings))) {
        return { ok: false, reason: "settings-invalid" };
      }
      const preparation = loadPreparation(loader);
      if (!preparation.ok) return preparation;
      const manager = ctx.sessionManager;
      const model = ctx.model;
      if (!model) return { ok: false, reason: "model-unavailable" };
      const effective = SettingsManager.inMemory(settings).getCompactionSettings(model);
      const sessionId = manager.getSessionId();
      const leafId = manager.getLeafId();
      if (typeof sessionId !== "string" || !sessionId || !(leafId === null || (typeof leafId === "string" && leafId.length > 0))) {
        return { ok: false, reason: "session-identity-invalid" };
      }
      const branch = manager.getBranch();
      if (!Array.isArray(branch)) return { ok: false, reason: "branch-invalid" };
      // Pure actual SDK preparation; no copied algorithm, provider call, abort or force.
      const prepared = preparation.prepare(branch, effective);
      getCwd.call(ctx);
      if (ctx.sessionManager !== manager || manager.getSessionId() !== sessionId || manager.getLeafId() !== leafId || ctx.model !== model) {
        return { ok: false, reason: "context-changed" };
      }
      if (prepared === undefined) return { ok: true, eligible: false, reason: "nothing-to-compact", sessionId, leafId };
      if (!isRecord(prepared) || typeof prepared.firstKeptEntryId !== "string" || !prepared.firstKeptEntryId ||
          !Array.isArray(prepared.messagesToSummarize) || !Array.isArray(prepared.turnPrefixMessages) ||
          typeof prepared.isSplitTurn !== "boolean" || typeof prepared.tokensBefore !== "number" ||
          !Number.isFinite(prepared.tokensBefore) || prepared.tokensBefore < 0 || !isRecord(prepared.fileOps) ||
          prepared.settings !== effective) {
        return { ok: false, reason: "sdk-prepare-invalid-result" };
      }
      return { ok: true, eligible: true, sessionId, leafId };
    } catch {
      // Do not expose module errors, settings or session content to consumers.
      return { ok: false, reason: "readiness-failed" };
    }
  };
}

/** Read-only, exact unbundled SDK1.3.0 readiness; not a trust grant or compaction API. */
export function readCompactionReadiness(ctx: ExtensionContext, settings: unknown): CompactionReadiness {
  return createCompactionReadinessReader()(ctx, settings);
}
