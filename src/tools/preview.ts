import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { SverseClient } from '../client.js';
import { buildSdkPlan, SDK_PACKAGES, sdkForEngine } from '../sdk/diff.js';
import { resolveProjectRoot } from '../scan/count.js';
import { OUTPUT_SCHEMA as OUTPUT, guarded, textResult } from './result.js';


export function registerPreviewSdk(server: McpServer, client: SverseClient): void {
  server.registerTool(
    'sverse_preview_sdk',
    {
      title: 'Sverse: preview SDK integration',
      description:
        'Generates the exact code diff needed to integrate a Sverse SDK into the local project, so the creator can ' +
        'review and apply it. NEVER writes files — sverse_run_step with install_sdk only records metadata. ' +
        'Picks the SDK from the project engine unless `sdk` is given. Returns a unified diff, the file list and any ' +
        'manual steps the CLI cannot perform. Read-only.',
      inputSchema: {
        path: z.string().optional().describe('Project directory. Defaults to SVERSE_PROJECT_DIR / server cwd.'),
        sdk: z
          .enum(SDK_PACKAGES as [string, ...string[]])
          .optional()
          .describe('SDK to preview. Defaults to the SDK for the detected engine (Unity → sverse-unity, Godot → sverse-godot, otherwise sverse-js).'),
        engine: z
          .enum(['unity', 'godot', 'js', 'unreal', 'other'])
          .optional()
          .describe('Engine hint used to choose the default SDK when the project cannot be inspected.'),
        version: z.string().max(20).optional().describe('SDK version to pin. Defaults to the version this server knows (0.1.0).'),
      },
      outputSchema: OUTPUT,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded({ path: z.string().optional(), sdk: z.string().optional(), engine: z.enum(['unity', 'godot', 'js', 'unreal', 'other']).optional(), version: z.string().max(20).optional() }, async (args) => {
      const root = await resolveProjectRoot(args.path ?? client.projectDir, client.projectDir);
      const files = await listRelevantFiles(root);
      const engine = args.engine ?? inferEngineFromFiles(files);
      const sdk = (args.sdk as (typeof SDK_PACKAGES)[number] | undefined) ?? sdkForEngine(engine);

      const me = await client.me().catch(() => null);
      const plan = buildSdkPlan({
        sdk,
        ...(args.version ? { version: args.version } : {}),
        ...(me ? { studioHandle: me.studio.handle } : {}),
        existingFiles: files,
      });

      const lines = [
        `SDK preview: ${plan.sdk}@${plan.version} for ${root} (engine: ${engine}).`,
        `Files that would change: ${plan.filesChanged.join(', ')}`,
        'Nothing was written to disk. Apply the diff below manually.',
        ...(plan.notes.length ? ['', ...plan.notes.map((note) => `Note: ${note}`)] : []),
        '',
        'Commands:',
        ...plan.commands.map((command) => `  ${command}`),
        '',
        'Diff:',
        plan.diff,
      ];
      return textResult(lines.join('\n'), {
        sdk: plan.sdk,
        version: plan.version,
        engine,
        path: root,
        filesChanged: plan.filesChanged,
        commands: plan.commands,
        diff: plan.diff,
        notes: plan.notes,
        wroteFiles: false,
      });
    }),
  );
}

/** Shallow listing of source files, enough to pick an entry point. Never recurses into build output. */
async function listRelevantFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of ['', 'src', 'app', 'scripts', 'scenes', 'Assets', 'project.godot', 'ProjectSettings', 'addons']) {
    const absolute = dir ? join(root, dir) : root;
    try {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) out.push(dir ? `${dir}/${entry.name}` : entry.name);
        if (out.length > 400) return out;
      }
    } catch {
      continue;
    }
  }
  return out;
}

function inferEngineFromFiles(files: string[]): 'unity' | 'godot' | 'js' | 'other' {
  const lower = files.map((file) => file.toLowerCase());
  if (lower.includes('projectsettings/projectversion.txt')) return 'unity';
  if (lower.includes('project.godot')) return 'godot';
  if (lower.includes('index.html') || lower.includes('package.json')) return 'js';
  return 'other';
}
