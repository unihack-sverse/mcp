import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { SverseClient } from '../client.js';
import { SDK_PACKAGES, SDK_VERSION } from '../sdk/diff.js';
import { blockedBecauseNotReady, isApproved, PUBLISH_STEPS } from './shared.js';
import { OUTPUT_SCHEMA as OUTPUT, formatUnits, guarded, textResult } from './result.js';
import { summarizeJob } from './shared.js';


/**
 * Client-side mirror of `STEP_INPUT` in `publish.service.js`, so obvious mistakes are rejected here
 * with a useful message instead of as a server 422. The server's copy remains authoritative.
 */
const STEP_INPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  scan_project: z.object({
    engine: z.enum(['unity', 'godot', 'js', 'unreal', 'other']).optional(),
    engineVersion: z.string().max(20).optional(),
    scenes: z.number().int().min(0).max(100000).optional(),
    surfaces: z.number().int().min(0).max(1000).optional(),
    monetizableObjects: z.array(z.string().max(80)).max(200).optional(),
  }),
  propose_items: z.object({
    draft: z
      .array(
        z.object({
          sku: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(),
          name: z.string().min(1).max(80),
          description: z.string().max(400).optional(),
          kind: z.enum(['cosmetic', 'bundle', 'pass', 'consumable', 'unlock', 'content', 'living']),
          priceUnits: z.string().regex(/^\d+$/).describe('Integer micro-SRV, e.g. "120000000" = 120 SRV'),
          slot: z.string().max(30).optional(),
          schemaId: z.string().optional(),
          interopTier: z.enum(['T0', 'T1', 'T2', 'T3']).optional(),
          traits: z.record(z.unknown()).optional(),
          supplyMax: z.number().int().positive().nullable().optional(),
          emoji: z.string().max(8).optional(),
        }),
      )
      .min(1)
      .max(100),
  }),
  map_to_schema: z.object({ overrides: z.record(z.string()).optional() }).default({}),
  create_item_pack: z.object({}).default({}),
  install_sdk: z.object({
    sdk: z.enum(SDK_PACKAGES as [string, ...string[]]),
    version: z.string().max(20),
    filesChanged: z.array(z.string().max(200)).max(200).optional(),
  }),
  test_purchase: z.object({}).default({}),
  publish: z.object({}).default({}),
};

const STEP_DESCRIPTIONS: Record<string, string> = {
  scan_project: 'Prefer sverse_scan_project, which scans real files. Use this only to override a recorded scan.',
  propose_items: 'Prefer sverse_propose_items, which derives the draft from the scan and maps schemas.',
  map_to_schema: 'Maps each draft item to a registered trait schema. Runs on the server; `overrides` maps sku → schemaId.',
  create_item_pack: 'Writes the approved catalogue as item definitions. Blocked until a human approves the catalogue in the console.',
  install_sdk: 'Records the SDK integration. Files are NOT written — use sverse_preview_sdk to get the diff.',
  test_purchase: 'Runs a sandbox purchase end-to-end with a test passport and refunds it.',
  publish: 'Submits the game for review. Prefer sverse_publish, which gates on every prior step.',
};

export function registerRunStep(server: McpServer, client: SverseClient): void {
  server.registerTool(
    'sverse_run_step',
    {
      title: 'Sverse: run a publish step',
      description:
        'Runs one step of the publish state machine on a job. Steps must run in order: scan_project, propose_items, ' +
        'map_to_schema, create_item_pack, install_sdk, test_purchase, publish. Re-running a step clears the output of ' +
        'every later step and invalidates catalogue approval, so only re-run to retry a failure. ' +
        'create_item_pack is refused here until a human approves the catalogue in the console: the tool returns ' +
        'instructions and makes no API call. Call sverse_get_job first to see which step is due.',
      inputSchema: {
        jobId: z.string().min(3).describe('Job id.'),
        step: z.enum(PUBLISH_STEPS).describe('Step to run.'),
        input: z.record(z.unknown()).optional().describe('Step input. map_to_schema/create_item_pack/test_purchase/publish take {}. See the step descriptions.'),
      },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded({ jobId: z.string(), step: z.enum(PUBLISH_STEPS), input: z.record(z.unknown()).optional() }, async ({ jobId, step, input }) => {
      const body = input ?? {};

      const parsed = STEP_INPUT_SCHEMAS[step]?.safeParse(body);
      if (parsed && !parsed.success) {
        const fields = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
        throw new Error(`Invalid input for step "${step}": ${fields}. ${STEP_DESCRIPTIONS[step] ?? ''}`);
      }
      const payload = parsed && parsed.success ? parsed.data : body;

      // Always read fresh state: deciding from cached state risks refusing right after the creator approved.
      const job = await client.getJob(jobId);

      if (step === 'create_item_pack') {
        if (!isApproved(job)) {
          const url = `${client.consoleUrl}/studio/publish?job=${encodeURIComponent(job.id)}`;
          return textResult(
            [
              'Blocked before calling the API: the catalogue needs human approval.',
              `Ask the creator to open ${url} and approve the proposed catalogue. Nothing has been written.`,
              'An API key cannot approve — approval is a human act (UC-19 §5).',
              'After they approve, call sverse_get_job (or this tool again): it re-reads the job, so it picks up the approval immediately.',
            ].join('\n'),
            {
              jobId: job.id,
              blocked: true,
              reason: 'catalog_not_approved',
              approvalUrl: url,
              catalogApproved: false,
              apiCalled: false,
              nextAction: { kind: 'approve-in-console', url },
            },
          );
        }
      }

      const notReady = blockedBecauseNotReady(job, step);
      if (notReady) {
        return textResult(
          [
            `No API call was made: "${notReady.step}" must finish before "${step}".`,
            `Run "${notReady.step}" first, then retry "${step}".`,
          ].join('\n'),
          { jobId: job.id, blocked: true, reason: 'step_out_of_order', blockingStep: notReady.step, apiCalled: false },
        );
      }

      if (step === 'publish') {
        return textResult(
          'Use sverse_publish for the publish step: it re-checks every gate and reports the review outcome in one call.',
          { jobId: job.id, apiCalled: false, redirect: 'sverse_publish' },
        );
      }

      const updated = await client.runStep(jobId, step, payload);
      const view = summarizeJob(updated, client.consoleUrl);
      const stepView = updated.steps.find((entry) => entry.step === step);
      const detail = renderStepOutput(step, stepView?.output);

      return textResult(
        [`Step "${step}" finished.`, ...detail, `Job ${updated.id} — ${updated.steps.filter((entry) => entry.status === 'done').length}/${updated.steps.length} steps done.`, '', `Next: ${view.message}`].join('\n'),
        {
          jobId: updated.id,
          step,
          status: stepView?.status,
          output: stepView?.output ?? null,
          catalogApproved: updated.catalogApproved,
          nextAction: view.nextAction,
        },
      );
    }),
  );
}

/** Step outputs differ enough that a generic JSON dump makes the transcript unreadable. */
function renderStepOutput(step: string, output: unknown): string[] {
  if (!output || typeof output !== 'object') return [];
  const record = output as Record<string, unknown>;
  switch (step) {
    case 'map_to_schema': {
      const mapped = Array.isArray(record.mapped) ? (record.mapped as Array<Record<string, unknown>>) : [];
      return mapped.map((entry) => `  - ${entry.sku}: ${entry.schemaId ?? 'unmapped'} (${entry.interopTier ?? 'T0'})`);
    }
    case 'create_item_pack': {
      const items = Array.isArray(record.items) ? (record.items as Array<Record<string, unknown>>) : [];
      return [`Created ${String(record.created ?? items.length)} item(s):`, ...items.map((item) => `  - ${item.sku}${item.existed ? ' (already existed)' : ''}`)];
    }
    case 'test_purchase':
      return [
        `Sandbox order ${String(record.orderId ?? '?')} for ${String(record.sku ?? '?')} at ${typeof record.priceUnits === 'string' ? formatUnits(record.priceUnits) : '?'}:`,
        `  settled: ${String(record.settled)} · refunded: ${String(record.refunded)} · chain: ${String(record.chain ?? 'n/a')}`,
      ];
    case 'install_sdk':
      return [`Recorded SDK ${String(record.sdk ?? '?')} ${String(record.version ?? '')}. No files were written: use sverse_preview_sdk for the diff.`];
    default:
      return [];
  }
}

export function registerPublish(server: McpServer, client: SverseClient): void {
  server.registerTool(
    'sverse_publish',
    {
      title: 'Sverse: publish game',
      description:
        'Terminal action: submits the game for review and runs the automated checks. Kept separate from sverse_run_step ' +
        'so it is never triggered by accident. Refuses unless every earlier step is done, the catalogue is approved, ' +
        'and the game has a build URL and at least one active item. Submitting is the only irreversible step in this flow.',
      inputSchema: {
        jobId: z.string().min(3).describe('Job id whose publish step should run.'),
      },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guarded({ jobId: z.string() }, async ({ jobId }) => {
      const job = await client.getJob(jobId);
      const gate = publishGateMessage(job, client.consoleUrl);
      if (gate) {
        return textResult(gate, { jobId: job.id, published: false, apiCalled: false, blockers: gate });
      }

      let updated;
      try {
        updated = await client.runStep(jobId, 'publish', {});
      } catch (error) {
        // publish() re-checks email verification, build URL and catalogue on the server; translate those to advice.
        const message = error instanceof Error ? error.message : String(error);
        return textResult(
          `The API refused to publish: ${message}\n\nFix that in the console (or add the missing items/build URL), then call sverse_publish again.`,
          { jobId: job.id, published: false, error: message },
        );
      }

      const output = updated.steps.find((entry) => entry.step === 'publish')?.output as Record<string, unknown> | null;
      const game = updated.game;
      const status = typeof output?.status === 'string' ? output.status : game?.status;
      const blockedReason = typeof output?.blockedReason === 'string' ? output.blockedReason : game?.blockedReason;
      const view = summarizeJob(updated, client.consoleUrl);

      return textResult(
        [
          `Submitted "${game?.title ?? 'game'}" for review.`,
          `Game status: ${status ?? 'unknown'}${blockedReason ? ` (blocked: ${blockedReason})` : ''}.`,
          typeof output?.slug === 'string' ? `Live slug: ${output.slug}` : '',
          typeof output?.reviewCaseId === 'string' ? `Review case: ${output.reviewCaseId}` : '',
          blockedReason === 'bond_required' ? 'The studio needs a larger bond before this game can go live; stake more in the console.' : '',
          '',
          `Job: ${view.message}`,
        ]
          .filter(Boolean)
          .join('\n'),
        { jobId: updated.id, published: true, status, blockedReason: blockedReason ?? null, reviewCaseId: output?.reviewCaseId ?? null, slug: output?.slug ?? null, nextAction: view.nextAction },
      );
    }),
  );
}

function publishGateMessage(job: Awaited<ReturnType<SverseClient['getJob']>>, consoleUrl: string): string | null {
  if (job.status === 'done') return 'This job is already finished. Nothing to publish.';
  const index = job.steps.findIndex((step) => step.step === 'publish');
  if (index < 0) return 'This job has no publish step.';
  const blocking = job.steps.slice(0, index).find((step) => !['done', 'skipped'].includes(step.status));
  if (blocking) return `Cannot publish yet: "${blocking.step}" is ${blocking.status}. Run it first — publish would be rejected as step_out_of_order.`;
  if (!job.catalogApproved) {
    return `Cannot publish: the catalogue is not approved. Ask the creator to approve it at ${consoleUrl}/studio/publish?job=${encodeURIComponent(job.id)}.`;
  }
  return null;
}

/** Exported for the smoke script: the exact payload shape `install_sdk` accepts. */
export const INSTALL_SDK_DEFAULT_VERSION = SDK_VERSION;
