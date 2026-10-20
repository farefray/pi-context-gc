// Scheduler only. Install a compaction backend separately when required.
export { default, createContextGcExtension, loadConfig } from "./src/extension.ts";
export { checkCompactionEligibility } from "./src/eligibility.ts";
export { readCompactionReadiness } from "./src/sdk-readiness.ts";
export type { CompactionReadiness } from "./src/sdk-readiness.ts";
export type { ContextGcAdmissionOptions } from "./src/extension.ts";
