// Explicit dependency injection for the inherited scheduler/lifecycle assertions.
// Production never reads sdkReadiness from a context. Actual SDK tests use no seam.
import { checkCompactionEligibility as check } from '../dist/src/eligibility.js';
import { createContextGcExtension as create } from '../dist/src/extension.js';
import { scheduleCheckpoint as schedule, startCompaction as start, maybeStartAtContextBoundary as boundary } from '../dist/src/runtime.js';
export * from '../dist/src/runtime.js';
export function testReadiness(ctx, settings) {
  if (typeof ctx.sdkReadiness !== 'function') return { ok: false, reason: 'test-sdk-unavailable' };
  return ctx.sdkReadiness(settings);
}
export const checkCompactionEligibility = (pi, ctx) => check(pi, ctx, testReadiness);
export const createContextGcExtension = (options) => create(options, testReadiness);
export const scheduleCheckpoint = (pi, ctx, runtime, id, input, config) => schedule(pi, ctx, runtime, id, input, config, testReadiness);
export const startCompaction = (pi, ctx, runtime, config) => start(pi, ctx, runtime, config, testReadiness);
export const maybeStartAtContextBoundary = (pi, ctx, runtime, config, messages) => boundary(pi, ctx, runtime, config, messages, testReadiness);
