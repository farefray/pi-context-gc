import { getPackageDir, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContextGcExtension, readCompactionReadiness } from '../../index.ts';

// Entirely synthetic provider and backend: no credentials, HTTP, user histories or host hooks.
export default function (pi: ExtensionAPI) {
  const proof: any = { calls: 0, compactions: 0, resumes: 0, accepted: null, settled: false };
  const save = () => writeFileSync(process.env.GC_PROBE_RESULT!, JSON.stringify(proof, null, 2));
  const input = { completed_phase: 'Synthetic phase A complete', next_focus: 'Synthetic phase B', keep: ['fixture only'], verification: ['deterministic local proof'] };
  pi.registerProvider('gc-offline-proof', {
    baseUrl: 'https://offline.invalid', api: 'gc-offline-proof-api', apiKey: 'unused-synthetic-placeholder',
    models: [{ id: 'fixture', name: 'GC offline fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const call = ++proof.calls;
        const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          content: [], stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message });
        if (options?.signal?.aborted) {
          message.stopReason = 'aborted'; message.errorMessage = 'synthetic abort';
          stream.push({ type: 'error', reason: 'aborted', error: message });
        } else if (call === 1) {
          const toolCall: any = { type: 'toolCall', id: 'gc-proof-call', name: 'compact_context', arguments: input };
          message.content.push(toolCall); message.stopReason = 'toolUse';
          stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
          stream.push({ type: 'done', reason: 'toolUse', message });
        } else {
          message.content.push({ type: 'text', text: 'Synthetic phase B complete' });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message });
          stream.push({ type: 'done', reason: 'stop', message });
        }
        stream.end(); save();
      });
      return stream;
    },
  });
  createContextGcExtension()(pi);
  pi.on('session_start', (_event, ctx) => {
    const require = process.getBuiltinModule('node:module').createRequire(import.meta.url);
    const dir = getPackageDir();
    const disk = require(join(dir, 'dist/core/settings-manager.js'));
    const { prepareCompaction } = require(join(dir, 'dist/core/compaction/compaction.js'));
    proof.identity = SettingsManager === disk.SettingsManager;
    proof.packageDir = dir;
    proof.short = readCompactionReadiness(ctx, pi.getSettings());
    for (let i = 0; i < 8; i++) pi.sendMessage({ customType: 'gc-proof-seed', display: false, content: `Synthetic phase ${i}: ` + 'bounded fixture history '.repeat(300) });
    const effective = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model!);
    const oracle = prepareCompaction(ctx.sessionManager.getBranch(), effective);
    proof.oracleEligible = oracle !== undefined;
    proof.eligible = readCompactionReadiness(ctx, pi.getSettings());
    proof.privateHookPresent = Object.keys(ctx).some(key => key.includes('Preflight'));
    save();
  });
  pi.on('tool_result', event => {
    if (event.toolName === 'compact_context') proof.accepted = (event.details as any)?.accepted;
    save();
  });
  pi.on('session_before_compact', (event, ctx) => {
    const require = process.getBuiltinModule('node:module').createRequire(import.meta.url);
    const { prepareCompaction } = require(join(getPackageDir(), 'dist/core/compaction/compaction.js'));
    const oracle = prepareCompaction(ctx.sessionManager.getBranch(), SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model!));
    proof.compactions++;
    proof.preparationMatches = JSON.stringify(event.preparation) === JSON.stringify(oracle);
    const branch = ctx.sessionManager.getBranch();
    proof.completeBatch = branch.some((entry: any) => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'gc-proof-call');
    save();
    return { compaction: { summary: 'Synthetic offline checkpoint', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });
  pi.on('agent_settled', (_event, ctx) => {
    proof.resumes = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === 'custom_message' && entry.customType === 'pi-context-gc-resume').length;
    proof.settled = true;
    save();
  });
}
