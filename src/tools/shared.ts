import type { PublishJob, PublishStep } from '../client.js';

export const PUBLISH_STEPS = [
  'scan_project',
  'propose_items',
  'map_to_schema',
  'create_item_pack',
  'install_sdk',
  'test_purchase',
  'publish',
] as const;
export type PublishStepName = (typeof PUBLISH_STEPS)[number];

/** Why the job is waiting, in a form a model can act on without re-reading every step. */
export type NextAction =
  | { kind: 'create-job' }
  | { kind: 'approve-in-console'; step: 'create_item_pack'; url: string; instructions: string }
  | { kind: 'run'; step: PublishStepName; tool: string; reason: string }
  | { kind: 'done' }
  | { kind: 'blocked'; reason: string; step?: string };

export interface JobView {
  jobId: string;
  mode: PublishJob['mode'];
  jobStatus: PublishJob['status'];
  game: PublishJob['game'];
  catalogApproved: boolean;
  steps: Array<{
    index: number;
    step: string;
    status: PublishStep['status'];
    blockedBy?: string;
    error?: { code: string; message: string };
  }>;
  nextAction: NextAction;
  /** Human-readable one-liner for the model to relay. */
  message: string;
}

export function summarizeJob(job: PublishJob, consoleUrl: string): JobView {
  const nextAction = nextActionFor(job, consoleUrl);
  const blocking = blockingStep(job);
  const steps: JobView['steps'] = job.steps.map((step) => ({
    index: step.index,
    step: step.step,
    status: step.status,
    ...(step.error ? { error: { code: step.error.code, message: step.error.message } } : {}),
    ...(blocking && step.step === blocking ? { blockedBy: 'earlier step is not done' } : {}),
  }));
  return {
    jobId: job.id,
    mode: job.mode,
    jobStatus: job.status,
    game: job.game,
    catalogApproved: job.catalogApproved,
    steps,
    nextAction,
    message: describeAction(nextAction, job),
  };
}

/**
 * The first step in pipeline order that is not done/skipped. Mirrors `runStep`'s own check, read
 * only from a freshly fetched job so an approval made in the console a moment ago is not missed.
 */
export function blockingStep(job: PublishJob): PublishStepName | undefined {
  const index = firstUndoneIndex(job);
  return index < 0 ? undefined : (job.steps[index]?.step as PublishStepName | undefined);
}

function firstUndoneIndex(job: PublishJob): number {
  return job.steps.findIndex((step) => !['done', 'skipped'].includes(step.status));
}

export function nextActionFor(job: PublishJob, consoleUrl: string): NextAction {
  if (job.status === 'done') return { kind: 'done' };
  const index = firstUndoneIndex(job);
  if (index < 0) return { kind: 'done' };
  const step = job.steps[index] as PublishStep;
  const failed = job.steps.find((entry) => entry.status === 'failed');
  if (failed && failed.error) {
    return {
      kind: 'blocked',
      step: failed.step,
      reason: `${failed.step} failed with ${failed.error.code}: ${failed.error.message}. Re-run that step to retry (this clears later steps).`,
    };
  }

  const name = step.step as PublishStepName;
  if (name === 'create_item_pack' && !job.catalogApproved) {
    const url = `${consoleUrl}/studio/publish?job=${encodeURIComponent(job.id)}`;
    return {
      kind: 'approve-in-console',
      step: 'create_item_pack',
      url,
      instructions:
        `The proposed catalogue needs human approval before items can be written. Open ${url} and approve it. ` +
        'An API key cannot approve (UC-19 §5). After approving, call sverse_run_step with step "create_item_pack".',
    };
  }

  if (name === 'publish') {
    const gate = publishGate(job);
    if (gate) return { kind: 'blocked', step: 'publish', reason: gate };
    return { kind: 'run', step: 'publish', tool: 'sverse_publish', reason: 'every earlier step is done and the catalogue is approved — this is the terminal action.' };
  }

  return {
    kind: 'run',
    step: name,
    tool: name === 'propose_items' ? 'sverse_propose_items' : name === 'scan_project' ? 'sverse_scan_project' : 'sverse_run_step',
    reason: `${name} is the first step that is not done.`,
  };
}

/** `sverse_publish` refuses unless every prior step is done and the catalogue is approved. */
export function publishGate(job: PublishJob): string | null {
  if (job.status === 'done') return 'This job is already finished.';
  const index = job.steps.findIndex((step) => step.step === 'publish');
  if (index < 0) return 'This job has no publish step.';
  const blocking = job.steps.slice(0, index).find((step) => !['done', 'skipped'].includes(step.status));
  if (blocking) return `"${blocking.step}" is not done, so publish would be rejected as step_out_of_order.`;
  if (!job.catalogApproved) return 'The catalogue is not approved; items cannot be written without human approval.';
  return null;
}

/**
 * The job reports approval from a fresh read in most callers, but a game-bound or re-fetched job can
 * still arrive without evidence of items. Treat a completed create_item_pack as approval too: it is
 * only recorded when the server itself saw `catalogApproved` and wrote the pack.
 */
export function isApproved(job: PublishJob): boolean {
  if (job.catalogApproved) return true;
  return job.steps.some((step) => step.step === 'create_item_pack' && step.status === 'done');
}

/** The first earlier step that would block `step`, mirroring `runStep`'s own check. */
export function blockedBecauseNotReady(
  job: PublishJob,
  step: PublishStepName,
): { step: string } | null {
  const index = job.steps.findIndex((entry) => entry.step === step);
  if (index < 0) return { step: step };
  const blocking = job.steps.slice(0, index).find((entry) => !['done', 'skipped'].includes(entry.status));
  return blocking ? { step: blocking.step } : null;
}

function describeAction(action: NextAction, job: PublishJob): string {
  switch (action.kind) {
    case 'create-job':
      return 'No job yet — create one with sverse_scan_project.';
    case 'approve-in-console':
      return action.instructions;
    case 'run':
      return `${job.game?.title ?? 'The game'} is at step "${action.step}": ${action.reason}`;
    case 'done':
      return `Job finished. Game status: ${job.game?.status ?? 'unknown'}${job.game?.blockedReason ? ` (${job.game.blockedReason})` : ''}.`;
    case 'blocked':
      return action.reason;
  }
}

/** Compact step output rendering — full outputs can be kilobytes and the model rarely needs them. */
export function compactStepOutput(step: PublishStep): unknown {
  return step.output ?? null;
}
