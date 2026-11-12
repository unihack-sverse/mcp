/**
 * Heuristic regression tests. No test runner: `npm test` runs this file with tsx so the package
 * stays dependency-light. Each case prints PASS/FAIL and the process exits non-zero on any failure.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanProject, toStepInput } from '../src/scan/count.js';
import { parseGodotMajor, parseUnityVersion } from '../src/scan/detect.js';
import { planDraft } from '../src/propose/plan.js';
import { fetchSchemas, type Schemas } from '../src/propose/schemas.js';
import { buildSdkPlan } from '../src/sdk/diff.js';
import { messageFor } from '../src/errors.js';
import { summarizeJob } from '../src/tools/shared.js';
import type { PublishJob } from '../src/client.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/godot-min', import.meta.url));

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    process.stdout.write(`PASS ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
}

function equal<T>(name: string, actual: T, expected: T): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- fixture scan
  const scan = await scanProject({ path: FIXTURE, baseDir: FIXTURE });
  equal('fixture engine', scan.engine, 'godot');
  equal('fixture engineVersion', scan.engineVersion, '4');
  equal('fixture scenes', scan.scenes, 3);
  equal('fixture surfaces', scan.surfaces, 2);
  equal('fixture monetizableObjects', scan.monetizableObjects, ['battle_pass', 'shop']);
  equal('fixture truncated', scan.truncated, false);
  check('fixture file count', scan.filesVisited === 5, scan.filesVisited);
  equal('fixture step input', toStepInput(scan), {
    engine: 'godot',
    engineVersion: '4',
    scenes: 3,
    surfaces: 2,
    monetizableObjects: ['battle_pass', 'shop'],
  });

  // ---------------------------------------------------------------- version parsing
  equal('godot config_version=5 → major 4', parseGodotMajor('config_version=5\n'), '4');
  equal('godot config_version=4 → major 3', parseGodotMajor('config_version=4\n'), '3');
  equal('godot features wins over config_version', parseGodotMajor('config_version=5\nconfig/features=PackedStringArray("4.3", "GL Compatibility")\n'), '4');
  equal('godot missing → undefined', parseGodotMajor('[application]\n'), undefined);
  equal('unity version', parseUnityVersion('m_EditorVersion: 2022.3.10f1\nm_EditorVersionWithRevision: 2022.3.10f1 (abc)\n'), '2022.3.10f1');
  equal('unity version missing', parseUnityVersion('nothing here'), undefined);

  // ---------------------------------------------------------------- engine detection variants
  const unityDir = await tempProject('unity', {
    'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2021.2.3f1\n',
    'Assets/Scenes/Main.unity': '%YAML 1.1\n',
    'Assets/Scenes/Shop.unity': '%YAML 1.1\n',
    'Assets/Store/Emporium.unity': '%YAML 1.1\n',
  });
  const unity = await scanProject({ path: unityDir, baseDir: unityDir });
  equal('unity engine', unity.engine, 'unity');
  equal('unity version', unity.engineVersion, '2021.2.3f1');
  equal('unity scenes', unity.scenes, 3);
  check('unity surfaces include shop and store', (unity.surfaces ?? 0) >= 2, unity.monetizableObjects);

  const jsDir = await tempProject('js', {
    'package.json': JSON.stringify({ name: 'game', dependencies: { phaser: '^3.70.0' } }),
    'index.html': '<html></html>',
    'src/main.js': 'console.log("hi")',
    'node_modules/phaser/dist/phaser.js': '// must be ignored',
  });
  const js = await scanProject({ path: jsDir, baseDir: jsDir });
  equal('js engine', js.engine, 'js');
  check('node_modules excluded', js.filesVisited === 3, js.filesVisited);

  const unknownDir = await tempProject('unknown', { 'README.md': '# nothing\n' });
  const unknown = await scanProject({ path: unknownDir, baseDir: unknownDir });
  equal('unknown engine', unknown.engine, 'other');
  check('unknown engine explains itself', unknown.notes.length > 0 && /Looked for/.test(unknown.notes.join(' ')), unknown.notes);
  equal('no surfaces means no surfaces key', 'surfaces' in unknown, false);

  // ---------------------------------------------------------------- traversal cap
  const cappedDir = await tempProject('capped', { 'project.godot': 'config_version=5\n' });
  for (let index = 0; index < 30; index += 1) {
    await writeFile(join(cappedDir, 'scenes', `shop_${index}.tscn`), '[gd_scene]\n');
  }
  const capped = await scanProject({ path: cappedDir, baseDir: cappedDir, maxFiles: 10 });
  check('cap truncates', capped.truncated === true, capped.filesVisited);
  check('cap explains itself', capped.notes.some((note) => /lower bound/.test(note)), capped.notes);

  // ---------------------------------------------------------------- draft planning
  const schemas = await offlineSchemas();
  const plan = planDraft(scan, { schemas, gameTitle: 'Voidrunner' });
  check('plan always has starter pack and season pass', plan.draft[0]?.sku === 'starter_pack' && plan.draft[1]?.sku === 'season_pass', plan.draft.map((item) => item.sku));
  check('plan cites files', plan.rationale.filter((entry) => entry.sources.length > 0).length >= 1, plan.rationale);
  check('every item has a real schema', plan.draft.every((item) => !item.schemaId || schemas.byId.has(item.schemaId)), plan.draft);
  check('bundle is at T2', plan.draft.find((item) => item.kind === 'bundle')?.interopTier === 'T2');
  check('consumable stays T0', (plan.draft.find((item) => item.kind === 'consumable')?.interopTier ?? 'T0') === 'T0');
  check('prices are integer strings', plan.draft.every((item) => /^\d+$/.test(item.priceUnits)), plan.draft.map((item) => item.priceUnits));
  check('no fabricated counts in rationale', plan.rationale.every((entry) => !/scenes: 12/.test(entry.reason)));

  const emptyPlan = planDraft({ engine: 'other', path: '.', signals: [], filesVisited: 0, truncated: false, notes: [], sceneFiles: [] }, { schemas, gameTitle: 'Empty' });
  equal('no-signal plan is only the baselines', emptyPlan.draft.map((item) => item.kind), ['bundle', 'pass']);
  check('no-signal plan says so', emptyPlan.noSignalDetected && /No monetizable surface/.test(emptyPlan.summary), emptyPlan.summary);

  // ---------------------------------------------------------------- SDK diff
  const diff = buildSdkPlan({ sdk: 'sverse-godot', studioHandle: 'kai.solo', existingFiles: ['project.godot'] });
  check('godot diff adds autoload', diff.diff.includes('Sverse=*res://addons/sverse/sverse.gd'), diff.diff.slice(0, 200));
  check('godot diff reports project.godot', diff.filesChanged.includes('project.godot'));
  const jsDiff = buildSdkPlan({ sdk: 'sverse-js', existingFiles: ['src/main.ts'] });
  check('js diff targets detected entry', jsDiff.filesChanged.includes('src/main.ts'), jsDiff.filesChanged);
  check('js diff warns it wrote nothing', jsDiff.notes.some((note) => /Nothing was written/.test(note)));

  // ---------------------------------------------------------------- error messages
  check('approval message names the console', /studio\/publish\?job=job_1/.test(messageFor('catalog_not_approved', undefined, { jobId: 'job_1', consoleUrl: 'http://localhost:3000' })));
  check('network error names the url', messageFor('network_error', undefined, { url: 'http://127.0.0.1:4000/sdk/v1/me' }).includes('http://127.0.0.1:4000/sdk/v1/me'));
  check('validation surface names fields', messageFor('invalid_step_input', undefined, { details: [{ field: 'draft.0.priceUnits', issue: 'must be a positive integer' }] }).includes('draft.0.priceUnits'));
  check('step order names blocking step', messageFor('step_out_of_order', undefined, { blockingStep: 'propose_items' }).includes('"propose_items"'));

  // ---------------------------------------------------------------- job summarising
  // The approval gate is at create_item_pack, so map_to_schema is due right after propose_items.
  const pendingJob = makeJob({ steps: statuses({ scan_project: 'done', propose_items: 'done' }) });
  equal('next action after propose is map_to_schema', summarizeJob(pendingJob, 'http://localhost:3000').nextAction.kind, 'run');
  equal('map_to_schema is the due step', (summarizeJob(pendingJob, 'http://localhost:3000').nextAction as { step?: string }).step, 'map_to_schema');
  const awaitingApproval = makeJob({ steps: statuses({ scan_project: 'done', propose_items: 'done', map_to_schema: 'done' }) });
  equal('next action before pack is approval', summarizeJob(awaitingApproval, 'http://localhost:3000').nextAction.kind, 'approve-in-console');
  const failedJob = makeJob({ steps: statuses({ scan_project: 'done', propose_items: 'failed' }) });
  equal('failed step reports blocked', summarizeJob(failedJob, 'http://localhost:3000').nextAction.kind, 'blocked');
  const doneJob = makeJob({ steps: statuses(Object.fromEntries(['scan_project', 'propose_items', 'map_to_schema', 'create_item_pack', 'install_sdk', 'test_purchase', 'publish'].map((step) => [step, 'done']))), status: 'done' });
  equal('finished job is done', summarizeJob(doneJob, 'http://localhost:3000').nextAction.kind, 'done');
  const approvedJob = makeJob({ steps: statuses({ scan_project: 'done', propose_items: 'done', map_to_schema: 'done' }), catalogApproved: true });
  equal('approved job runs create_item_pack', summarizeJob(approvedJob, 'http://localhost:3000').nextAction.kind, 'run');

  process.stdout.write(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`);
  if (failures > 0) process.exitCode = 1;
}

async function tempProject(name: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `sverse-mcp-${name}-`));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }
  await mkdir(join(root, 'scenes'), { recursive: true });
  return root;
}

/**
 * The seeded trait registry, copied so the tests run without a backend. `fetchSchemas` is still
 * exercised by the smoke script against the real API.
 */
async function offlineSchemas(): Promise<Schemas> {
  void fetchSchemas;
  const rows = [
    { schemaId: 'sts/bundle/v1', class: 'bundle', subclass: '', fields: [], allowedInteropTiers: ['T0', 'T1', 'T2'], status: 'active' },
    { schemaId: 'sts/cosmetic/wearable/v1', class: 'cosmetic', subclass: 'wearable', fields: [{ name: 'slot', type: 'enum', values: ['torso', 'head'] }], allowedInteropTiers: ['T0', 'T1'], status: 'active' },
    { schemaId: 'sts/cosmetic/trail/v1', class: 'cosmetic', subclass: 'trail', fields: [{ name: 'slot', type: 'enum', values: ['trail'] }], allowedInteropTiers: ['T0', 'T1'], status: 'active' },
    { schemaId: 'sts/consumable/charge/v1', class: 'consumable', subclass: 'charge', fields: [], allowedInteropTiers: ['T0'], status: 'active' },
    { schemaId: 'sts/weapon/melee/v1', class: 'weapon', subclass: 'melee', fields: [], allowedInteropTiers: ['T0', 'T1', 'T2'], status: 'active' },
  ] as const;
  const all = rows.map((row, index) => ({ ...row, id: `sts_${index}`, version: '1' })) as unknown as Schemas['all'];
  return { all, byId: new Map(all.map((schema) => [schema.schemaId, schema])) };
}

function statuses(map: Record<string, PublishJob['steps'][number]['status']>): PublishJob['steps'] {
  return ['scan_project', 'propose_items', 'map_to_schema', 'create_item_pack', 'install_sdk', 'test_purchase', 'publish']
    .filter((step) => step in map || true)
    .map((step, index) => ({
      index: index + 1,
      step,
      name: step,
      status: map[step] ?? 'pending',
      requiresApproval: step === 'create_item_pack',
      output: null,
      error: map[step] === 'failed' ? { code: 'empty_catalog', message: 'nothing to do' } : null,
      startedAt: null,
      finishedAt: null,
    }));
}

function makeJob(overrides: Partial<PublishJob>): PublishJob {
  return {
    id: 'job_test',
    mode: 'ai',
    status: 'running',
    gameId: 'gam_voidrunner',
    game: { id: 'gam_voidrunner', slug: 'voidrunner', title: 'Voidrunner', status: 'draft' },
    catalogApproved: false,
    draftCatalog: [],
    steps: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
