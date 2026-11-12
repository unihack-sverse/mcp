import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { SverseClient } from '../client.js';
import { OUTPUT_SCHEMA as OUTPUT, guarded, textResult } from './result.js';
import { summarizeJob } from './shared.js';


export function registerWhoami(server: McpServer, client: SverseClient): void {
  server.registerTool(
    'sverse_whoami',
    {
      title: 'Sverse: who am I',
      description:
        'Reports which Sverse studio and game the configured API key belongs to, plus its scopes. ' +
        'Call this first: it proves the key is valid, shows whether the key is bound to a single game ' +
        '(then every publish job must be for that game) and whether it carries the "publish" scope. ' +
        'Read-only; makes no changes.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded({}, async () => {
      const me = await client.me();
      const hasPublish = me.scopes.includes('publish');
      const lines = [
        `Studio: ${me.studio.handle} (${me.studio.id})`,
        `Game bound to key: ${me.game ? `${me.game.title} (${me.game.slug}, ${me.game.status})` : 'none — game-scoped calls need a key bound to a game'}`,
        `Scopes: ${me.scopes.join(', ') || 'none'}`,
        hasPublish
          ? 'The key can publish.'
          : 'This key CANNOT publish: it lacks the "publish" scope and every publish tool will fail with insufficient_scope.',
      ];
      return textResult(lines.join('\n'), { me, canPublish: hasPublish });
    }),
  );
}

export function registerGetJob(server: McpServer, client: SverseClient): void {
  server.registerTool(
    'sverse_get_job',
    {
      title: 'Sverse: get publish job',
      description:
        'Fetches a publish job and states what to do next. Always reads fresh state, so call this after asking ' +
        'the creator to approve the catalogue in the console rather than assuming the approval failed. ' +
        '`nextAction.kind` is one of: run (with the step and which tool to use), approve-in-console, done, blocked. ' +
        'Read-only; makes no changes.',
      inputSchema: {
        jobId: z.string().min(3).describe('Job id returned by sverse_scan_project, e.g. job_abc123'),
      },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded({ jobId: z.string() }, async ({ jobId }) => {
      const job = await client.getJob(jobId);
      const view = summarizeJob(job, client.consoleUrl);
      const lines = [
        `Job ${job.id} — ${job.status}${job.game ? ` for "${job.game.title}" (${job.game.status})` : ''}`,
        `Catalogue approved: ${job.catalogApproved ? 'yes' : 'no'}`,
        ...view.steps.map((step) => `  ${step.status === 'done' ? '[x]' : step.status === 'failed' ? '[!]' : '[ ]'} ${step.step}${step.error ? ` — ${step.error.message}` : ''}`),
        '',
        `Next: ${view.message}`,
      ];
      return textResult(lines.join('\n'), {
        jobId: job.id,
        status: job.status,
        game: job.game,
        catalogApproved: job.catalogApproved,
        steps: job.steps.map((step) => ({ index: step.index, step: step.step, status: step.status, output: step.output, error: step.error })),
        nextAction: view.nextAction,
        draftCatalog: job.draftCatalog,
      });
    }),
  );
}

export type { CallToolResult };
