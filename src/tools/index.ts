import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { SverseClient } from '../client.js';
import { registerPreviewSdk } from './preview.js';
import { registerPublish, registerRunStep } from './run.js';
import { registerProposeItems, registerScanProject } from './scan.js';
import { registerGetJob, registerWhoami } from './studio.js';

/**
 * The seven tools, in the order a model should consider them.
 *
 * `concept/sverse-concept.md` lists nine; `create_studio` is dropped because a creator already has an
 * account by the time they own an API key (studio creation stays a console action), and
 * `create_item_pack` is not a separate tool because it is one step of `sverse_run_step` guarded by
 * the approval gate. `emit_deed` belongs to the game's runtime SDK, not to publishing.
 */
export const TOOL_NAMES = [
  'sverse_whoami',
  'sverse_scan_project',
  'sverse_propose_items',
  'sverse_run_step',
  'sverse_get_job',
  'sverse_publish',
  'sverse_preview_sdk',
] as const;

export function registerTools(server: McpServer, client: SverseClient): void {
  registerWhoami(server, client);
  registerScanProject(server, client);
  registerProposeItems(server, client);
  registerRunStep(server, client);
  registerGetJob(server, client);
  registerPublish(server, client);
  registerPreviewSdk(server, client);
}
