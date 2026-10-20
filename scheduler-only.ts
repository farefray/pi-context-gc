// Explicit alias; the package manifest also loads only the scheduler.
export { default, createContextGcExtension, loadConfig, checkCompactionEligibility, readCompactionReadiness } from "./index.ts";
export type { ContextGcAdmissionOptions, CompactionReadiness } from "./index.ts";
