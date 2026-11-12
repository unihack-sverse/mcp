import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CreateJobInput, PublishJob, SverseClient } from '../client.js';
import { planDraft } from '../propose/plan.js';
import { fetchSchemas } from '../propose/schemas.js';
import { scanProject, toStepInput } from '../scan/count.js';
import type { Engine, ScanReport } from '../scan/models.js';
import { OUTPUT_SCHEMA as OUTPUT, formatUnits, guarded, textResult } from './result.js';
import { summarizeJob } from './shared.js';


const ENGINES = ['unity', 'godot', 'js', 'unreal', 'other'] as const;

export function registerScanProject(server: McpServer, client: SverseClient): void {
  server.registerTool(
    'sverse_scan_project',
    {
      title: 'Sverse: scan game project',
      description:
        'Scans the game source directory on this machine, detects the engine, and counts scenes and monetisation ' +
        'surfaces from real files. Creates a publish job (or reuses the running job for the same game) and records ' +
        'the scan as its first step. This is the entry point for publishing. ' +
        'Counts are omitted rather than guessed when they cannot be determined; read `notes` before relaying them. ' +
        'Writes nothing outside a new publish job.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Project directory to scan. Defaults to SVERSE_PROJECT_DIR / the server working directory. Absolute is safest.'),
        gameId: z.string().optional().describe('Game id to publish (from sverse_whoami or the console). A game-bound key may omit it.'),
        title: z.string().min(2).max(80).optional().describe('Title for a NEW game. Only used when gameId is omitted and the key is not game-bound.'),
        genre: z.string().optional().describe('Genre for a new game: action_rpg, puzzle, strategy, cozy, arcade, platformer.'),
        engine: z
          .enum(ENGINES)
          .optional()
          .describe('Force the engine instead of detecting it. Use only when detection returned "other" and you know the engine.'),
      },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded({ path: z.string().optional(), gameId: z.string().optional(), title: z.string().min(2).max(80).optional(), genre: z.string().optional(), engine: z.enum(ENGINES).optional() }, async (args) => {
      const scan = await scanProject({
        path: args.path ?? client.projectDir,
        baseDir: client.projectDir,
        ...(args.engine ? { engine: args.engine } : {}),
      });

      const createInput: CreateJobInput = { mode: 'ai' };
      /**
       * A game-bound key identifies its game already; asking the caller to repeat it was the reason a
       * bound key still hit `game_required`. Only ask the API who we are when it would change the call.
       */
      if (args.gameId) {
        createInput.gameId = args.gameId;
      } else if (args.title) {
        createInput.title = args.title;
      } else {
        const me = await client.me();
        if (me.game?.id) createInput.gameId = me.game.id;
        else {
          throw new Error(
            'No game to publish. Pass `gameId` (see sverse_whoami), pass `title` to create a new game, '
            + 'or bind the API key to a game in the console.',
          );
        }
      }
      if (args.genre) createInput.genre = args.genre;
      const created = await client.createJob(createInput);

      // A running job for this game is returned as-is; its existing scan step must be re-run to record a new scan.
      const existingScan = created.steps.find((step) => step.step === 'scan_project');
      let job: PublishJob = created;
      let recorded = false;
      if (!existingScan || existingScan.status !== 'done') {
        job = await client.runStep(created.id, 'scan_project', toStepInput(scan));
        recorded = true;
      }

      const view = summarizeJob(job, client.consoleUrl);
      const countNote = scan.truncated ? 'at least ' : '';
      const lines = [
        `Scanned ${scan.path}: engine ${scan.engine}${scan.engineVersion ? ` ${scan.engineVersion}` : ''}, ${countNote}${scan.scenes ?? 0} scene(s), ${countNote}${scan.surfaces ?? 0} monetisation surface(s).`,
        `Job ${job.id} for "${job.game?.title ?? 'game'}" (reused an existing running job if one was open).`,
        ...(recorded ? [] : ['The job already had a completed scan step, so this scan is reported here but not re-recorded. A retry would clear later steps.']),
        ...(scan.notes.length ? ['Notes:', ...scan.notes.map((note) => `  - ${note}`)] : []),
        ...(scan.monetizableObjects?.length ? [`Signals: ${scan.monetizableObjects.join(', ')}`] : []),
        '',
        `Next: ${view.message}`,
      ];
      return textResult(lines.join('\n'), {
        jobId: job.id,
        game: job.game,
        scan: {
          engine: scan.engine,
          engineVersion: scan.engineVersion,
          scenes: scan.scenes,
          surfaces: scan.surfaces,
          monetizableObjects: scan.monetizableObjects ?? [],
          truncated: scan.truncated,
          filesVisited: scan.filesVisited,
          sceneFiles: scan.sceneFiles,
          signals: scan.signals,
          path: scan.path,
        },
        notes: scan.notes,
        nextAction: view.nextAction,
      });
    }),
  );
}

export function registerProposeItems(server: McpServer, client: SverseClient): void {
  server.registerTool(
    'sverse_propose_items',
    {
      title: 'Sverse: propose catalogue',
      description:
        'Builds a catalogue draft from what sverse_scan_project actually found and records it on the job. ' +
        'Deterministic: the same project always yields the same draft, and every item lists the file that ' +
        'justified it in `rationale`. Always proposes a Starter Pack and a Season Pass; adds cosmetics per slot ' +
        'found and a consumable when a loot/chest surface exists. Prices are integer micro-SRV (6 decimals). ' +
        'This does NOT write items — the draft needs human approval in the console first. Re-running it clears ' +
        'the approval and every later step.',
      inputSchema: {
        jobId: z.string().min(3).describe('Job id from sverse_scan_project.'),
        path: z.string().optional().describe('Project directory if the job was created in another session; omit to use the one from the job.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum items to propose (default 8, all rules included).'),
      },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded({ jobId: z.string(), path: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }, async ({ jobId, path, limit }) => {
      const job = await client.getJob(jobId);
      const schemas = await fetchSchemas(client);

      const scan = await scanFromJobOrDisk(client, job, path);
      if (!scan) {
        throw new Error(
          'This job has no completed scan_project step, so there is nothing honest to base a catalogue on. ' +
            'Run sverse_scan_project first, or pass `path` so it can be scanned now.',
        );
      }

      const plan = planDraft(scan, { schemas, gameTitle: job.game?.title ?? 'Game' });
      const draft = limit ? plan.draft.slice(0, limit) : plan.draft;

      const updated = await client.runStep(jobId, 'propose_items', { draft });
      const view = summarizeJob(updated, client.consoleUrl);

      const lines = [
        `Proposed ${draft.length} item(s) for "${job.game?.title ?? 'game'}".`,
        plan.summary,
        '',
        ...draft.map((item) => `  - ${item.name} [${item.kind}] ${formatUnits(item.priceUnits)} → ${item.schemaId ?? 'no schema (T0, entitlement)'} ${item.interopTier ?? 'T0'}`),
        '',
        'Rationale:',
        ...plan.rationale.map((entry) => `  - ${entry.sku}: ${entry.reason}${entry.sources.length ? ` (source: ${entry.sources.join(', ')})` : ''}`),
        '',
        `Next: ${view.message}`,
      ];
      return textResult(lines.join('\n'), {
        jobId: updated.id,
        draft,
        rationale: plan.rationale,
        noSignalDetected: plan.noSignalDetected,
        scan: { engine: scan.engine, scenes: scan.scenes, surfaces: scan.surfaces, monetizableObjects: scan.monetizableObjects ?? [] },
        catalogApproved: updated.catalogApproved,
        nextAction: view.nextAction,
      });
    }),
  );
}

/**
 * Prefers the scan the job already recorded: that is the input the rest of the pipeline is built on.
 * Falls back to re-scanning only when the job has no scan output (e.g. it was created in the console).
 */
async function scanFromJobOrDisk(client: SverseClient, job: PublishJob, path?: string): Promise<ScanReport | null> {
  const recorded = job.steps.find((step) => step.step === 'scan_project' && step.status === 'done')?.output as Partial<ScanReport> | null | undefined;
  if (recorded && typeof recorded === 'object' && 'engine' in recorded && recorded.engine) {
    return {
      engine: recorded.engine,
      ...(recorded.engineVersion ? { engineVersion: recorded.engineVersion } : {}),
      ...(typeof recorded.scenes === 'number' ? { scenes: recorded.scenes } : {}),
      ...(typeof recorded.surfaces === 'number' ? { surfaces: recorded.surfaces } : {}),
      ...(recorded.monetizableObjects ? { monetizableObjects: recorded.monetizableObjects } : {}),
      path: path ?? client.projectDir,
      signals: recorded.signals ?? [],
      filesVisited: typeof recorded.filesVisited === 'number' ? recorded.filesVisited : 0,
      truncated: Boolean(recorded.truncated),
      notes: [],
      sceneFiles: recorded.sceneFiles ?? [],
    };
  }
  if (path && job.steps.find((step) => step.step === 'scan_project')) {
    return scanProject({ path, baseDir: client.projectDir });
  }
  return null;
}
