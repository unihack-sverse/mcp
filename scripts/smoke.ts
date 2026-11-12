/**
 * End-to-end smoke test against a local backend.
 *
 *   cd backend-v2 && npm run seed:reset && npm run dev     # backend on :4000
 *   cd backend-v2 && node scripts/mint-mcp-key.mjs publish,read
 *   cd mcp && $env:SVERSE_API_KEY='sk_live_…'; npm run smoke
 *
 * The flow stops at the human approval gate exactly as a real MCP client would, proves that an API
 * key cannot approve, then — unless SVERSE_SMOKE_HUMAN=1 — approves out of band so the rest of the
 * pipeline is exercised. Nothing here is part of the published build.
 *
 * Negative checks (bad scope, wrong game) run by default and each mints its own key.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SverseClient, type PublishJob } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { planDraft } from '../src/propose/plan.js';
import { fetchSchemas } from '../src/propose/schemas.js';
import { scanProject, toStepInput } from '../src/scan/count.js';
import { buildSdkPlan } from '../src/sdk/diff.js';
import { summarizeJob } from '../src/tools/shared.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(MCP_ROOT, '..');
const FIXTURE = join(MCP_ROOT, 'test', 'fixtures', 'godot-min');
const BACKEND = join(REPO_ROOT, 'backend-v2');

let failures = 0;
const results: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    results.push(`PASS ${name}`);
    process.stdout.write(`PASS ${name}\n`);
    return;
  }
  failures += 1;
  results.push(`FAIL ${name} — ${JSON.stringify(detail)}`);
  process.stdout.write(`FAIL ${name} — ${JSON.stringify(detail)}\n`);
}

function step(title: string): void {
  process.stdout.write(`\n== ${title}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SverseClient(config);
  process.stdout.write(`smoke against ${config.apiUrl} (console ${config.consoleUrl})\n`);

  // ---------------------------------------------------------------- 1. identity
  step('sverse_whoami');
  const me = await client.me();
  check('key resolves to a studio', Boolean(me.studio.handle), me.studio);
  check('studio is kai.solo', me.studio.handle === 'kai.solo', me.studio.handle);
  check('key has publish scope', me.scopes.includes('publish'), me.scopes);
  if (!me.scopes.includes('read')) {
    throw new Error('This key also needs the "read" scope for GET /schemas (sverse_propose_items). Mint with publish,read.');
  }

  // ---------------------------------------------------------------- 2. scan
  step('sverse_scan_project');
  const scan = await scanProject({ path: FIXTURE, baseDir: FIXTURE });
  check('fixture engine is godot', scan.engine === 'godot', scan.engine);
  check('fixture scenes is 3', scan.scenes === 3, scan.scenes);
  check('fixture surfaces is 2', scan.surfaces === 2, scan.surfaces);
  check('fixture monetizableObjects', JSON.stringify(scan.monetizableObjects) === JSON.stringify(['battle_pass', 'shop']), scan.monetizableObjects);

  const created = await client.createJob(me.game ? {} : { title: `MCP Smoke ${Date.now()}` });
  const jobId = created.id;
  let job: PublishJob = await client.runStep(jobId, 'scan_project', toStepInput(scan));
  check('scan step recorded', job.steps.find((entry) => entry.step === 'scan_project')?.status === 'done', job.steps[0]);
  const recorded = job.steps[0]?.output as Record<string, unknown> | undefined;
  check('server stored engine godot', recorded?.engine === 'godot', recorded);
  check('server stored scenes 3', recorded?.scenes === 3, recorded);
  process.stdout.write(`job ${jobId} for game ${job.game?.title}\n`);
  if (!created.game?.id) throw new Error('createJob returned no game id');
  ensureSubmitReady(created.game.id);

  // ---------------------------------------------------------------- 3. propose
  step('sverse_propose_items');
  const schemas = await fetchSchemas(client);
  check('schemas fetched', schemas.all.length > 0, schemas.all.length);
  const plan = planDraft(scan, { schemas, gameTitle: job.game?.title ?? 'Game' });
  check('draft has baselines', plan.draft.some((item) => item.kind === 'bundle') && plan.draft.some((item) => item.kind === 'pass'), plan.draft.map((item) => item.kind));
  check('every schemaId exists in /schemas', plan.draft.every((item) => !item.schemaId || schemas.byId.has(item.schemaId)), plan.draft.map((item) => item.schemaId));
  check('rationale cites files', plan.rationale.some((entry) => entry.sources.length > 0), plan.rationale);
  job = await client.runStep(jobId, 'propose_items', { draft: plan.draft });
  check('propose step recorded', job.steps.find((entry) => entry.step === 'propose_items')?.status === 'done');
  check('catalogue not approved after propose', job.catalogApproved === false);
  job = await client.runStep(jobId, 'map_to_schema', {});
  const mapped = job.steps.find((entry) => entry.step === 'map_to_schema')?.output as { mapped?: Array<Record<string, unknown>> } | undefined;
  const portableless = new Set(['pass', 'consumable', 'unlock']);
  const draftBySku = new Map(plan.draft.map((item) => [item.sku, item]));
  const unmapped = (mapped?.mapped ?? []).filter(
    (item) => !item.schemaId && !portableless.has(String(draftBySku.get(String(item.sku))?.kind ?? '')),
  );
  check('every portable item got a schema', unmapped.length === 0, unmapped);
  check('pass stays an unmapped entitlement', (mapped?.mapped ?? []).find((item) => item.sku === 'season_pass')?.schemaId === null);
  check('server agrees with client tier for bundle', (mapped?.mapped ?? []).find((item) => item.sku === 'starter_pack')?.interopTier === draftBySku.get('starter_pack')?.interopTier, mapped?.mapped);

  // ---------------------------------------------------------------- 4. approval gate
  step('approval gate');
  let approvalError: string | null = null;
  try {
    await client.runStep(jobId, 'create_item_pack', {});
  } catch (error) {
    approvalError = error instanceof Error ? error.message : String(error);
  }
  check('create_item_pack blocked before approval', approvalError !== null && /needs human approval|human approval|approve/i.test(approvalError), approvalError);
  const approvalUrl = `${client.consoleUrl}/studio/publish?job=${jobId}`;
  process.stdout.write(`Approve at: ${approvalUrl}\n`);

  const human = process.env.SVERSE_SMOKE_HUMAN === '1';
  if (human) {
    process.stdout.write('SVERSE_SMOKE_HUMAN=1: approve in the console, then the job will be polled for up to 5 minutes…\n');
    job = await waitForApproval(client, jobId, 300_000);
  } else {
    approveOutOfBand(jobId);
    job = await client.getJob(jobId);
  }
  check('catalogue approved', job.catalogApproved === true, job.catalogApproved);

  // ---------------------------------------------------------------- 5. remaining steps
  step('create_item_pack → install_sdk → test_purchase → publish');
  job = await client.runStep(jobId, 'create_item_pack', {});
  const pack = job.steps.find((entry) => entry.step === 'create_item_pack')?.output as { created?: number } | undefined;
  check('item pack written', (pack?.created ?? 0) > 0, pack);

  const sdk = buildSdkPlan({ sdk: 'sverse-godot', studioHandle: me.studio.handle, existingFiles: ['project.godot'] });
  check('sdk preview writes nothing', sdk.diff.length > 0 && !existsSync(join(FIXTURE, 'addons')), sdk.filesChanged);
  job = await client.runStep(jobId, 'install_sdk', { sdk: sdk.sdk, version: sdk.version, filesChanged: sdk.filesChanged });
  check('install_sdk recorded', job.steps.find((entry) => entry.step === 'install_sdk')?.status === 'done');

  job = await client.runStep(jobId, 'test_purchase', {});
  const purchase = job.steps.find((entry) => entry.step === 'test_purchase')?.output as { settled?: boolean; refunded?: boolean; orderId?: string } | undefined;
  check('test purchase settled', purchase?.settled === true, purchase);
  check('test purchase refunded', purchase?.refunded === true, purchase);

  const gate = summarizeJob(job, client.consoleUrl);
  check('publish is the next action', gate.nextAction.kind === 'run' && gate.nextAction.step === 'publish', gate.nextAction);

  job = await client.runStep(jobId, 'publish', {});
  const publish = job.steps.find((entry) => entry.step === 'publish')?.output as Record<string, unknown> | undefined;
  check('publish step ran', Boolean(publish), publish);
  check('game reached in_review or live', ['in_review', 'live'].includes(String(publish?.status ?? job.game?.status)), publish?.status ?? job.game?.status);
  check('job is done', job.status === 'done', job.status);
  process.stdout.write(`game status: ${String(publish?.status ?? job.game?.status)}${publish?.blockedReason ? ` (blocked: ${String(publish.blockedReason)})` : ''}\n`);

  // ---------------------------------------------------------------- 6. negatives
  step('negative: key without publish scope');
  const gameScopedKey = mintKey('game', job.gameId ?? 'gam_voidrunner');
  const gameOnly = new SverseClient({ ...config, apiKey: gameScopedKey });
  let scopeError: string | null = null;
  try {
    await gameOnly.createJob({ gameId: job.gameId ?? 'gam_voidrunner' });
  } catch (error) {
    scopeError = error instanceof Error ? error.message : String(error);
  }
  check('publish route refused without the scope', scopeError !== null && /scope/.test(scopeError), scopeError);

  step('negative: key bound to a different game');
  const otherGameId = await firstGameNot(job.gameId ?? 'gam_voidrunner');
  if (!otherGameId) {
    process.stdout.write('SKIP — the kai.solo studio has only one game; mint a key for another studio to test this.\n');
  } else {
    const otherKey = mintKey('publish,read', otherGameId);
    const bound = new SverseClient({ ...config, apiKey: otherKey });
    let jobError: string | null = null;
    try {
      await bound.getJob(jobId);
    } catch (error) {
      jobError = error instanceof Error ? error.message : String(error);
    }
    check('job from another game is refused', jobError !== null && /not belong|not_your_job|does not belong/i.test(jobError), jobError);
  }

  process.stdout.write(`\n${failures === 0 ? 'smoke passed' : `${failures} check(s) failed`} (job ${jobId})\n`);
  if (failures > 0) process.exitCode = 1;
}

async function waitForApproval(client: SverseClient, jobId: string, timeoutMs: number): Promise<PublishJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await client.getJob(jobId);
    if (job.catalogApproved) return job;
    await new Promise((settle) => setTimeout(settle, 3000));
  }
  throw new Error('Timed out waiting for the catalogue to be approved in the console.');
}

/**
 * Approves as the studio owner would, directly in the database. Only used to let the smoke test
 * finish unattended — the approval path the product uses is the console action.
 */
function approveOutOfBand(jobId: string): void {
  const script = `
    import('./src/db/register-models.js').then(async () => {
      const { connectDatabase, disconnectDatabase } = await import('./src/db/connection.js');
      const { PublishJobModel } = await import('./src/modules/publish/models/index.js');
      const { StudioModel } = await import('./src/modules/studios/models/index.js');
      await connectDatabase();
      const job = await PublishJobModel.findOne({ pid: process.argv[1] }).lean();
      const studio = await StudioModel.findById(job.studioId).lean();
      await PublishJobModel.updateOne({ pid: process.argv[1] }, { $set: { catalogApproved: true, approvedByUserId: studio.ownerUserId } });
      await disconnectDatabase();
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, jobId], { cwd: BACKEND, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Out-of-band approval failed: ${result.stderr || result.stdout}`);
  process.stdout.write('Approved out of band (simulating the creator clicking Approve in the console).\n');
}

function mintKey(scopes: string, gameId?: string): string {
  const script = join(BACKEND, 'scripts', 'mint-mcp-key.mjs');
  if (!existsSync(script)) throw new Error(`Missing ${script}; it is part of backend-v2 for testing only.`);
  const result = spawnSync(process.execPath, [script, scopes, ...(gameId ? [gameId] : [])], { cwd: BACKEND, encoding: 'utf8' });
  const secret = (result.stdout ?? '').trim();
  if (result.status !== 0 || !/^sk_(live|test)_[0-9A-Za-z]{32}$/.test(secret)) {
    throw new Error(`Could not mint a ${scopes} key: ${result.stderr || result.stdout}`);
  }
  return secret;
}

/**
 * `publish` calls `reviewService.submit`, which refuses a game without a build URL (it cannot
 * malware-scan nothing). A freshly created game has none, so give it a real https URL directly in
 * the database — the same field the console's game editor writes.
 */
function ensureSubmitReady(gameId: string): void {
  const script = `
    import('./src/db/register-models.js').then(async () => {
      const { connectDatabase, disconnectDatabase } = await import('./src/db/connection.js');
      const { GameModel } = await import('./src/modules/games/models/index.js');
      await connectDatabase();
      const game = await GameModel.findOne({ pid: process.argv[1] }).lean();
      if (game && !game.buildUrl) {
        await GameModel.updateOne({ _id: game._id }, { $set: { buildUrl: 'https://example.com/sverse-smoke-game' } });
      }
      await disconnectDatabase();
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, gameId], { cwd: BACKEND, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not set a build URL on ${gameId}: ${result.stderr || result.stdout}`);
}

async function firstGameNot(gameId: string): Promise<string | null> {
  const script = `
    import('./src/db/register-models.js').then(async () => {
      const { connectDatabase, disconnectDatabase } = await import('./src/db/connection.js');
      const { GameModel } = await import('./src/modules/games/models/index.js');
      await connectDatabase();
      const game = await GameModel.findOne({ pid: { $ne: process.argv[1] } }).lean();
      process.stdout.write(game ? game.pid : '');
      await disconnectDatabase();
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, gameId], { cwd: BACKEND, encoding: 'utf8' });
  return (result.stdout ?? '').trim() || null;
}

main().catch((error: unknown) => {
  process.stderr.write(`\nsmoke failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
