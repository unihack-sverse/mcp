import { open, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ToolError } from '../errors.js';
import { detectEngine, type Detection } from './detect.js';
import type { Engine, ScanReport, ScanSignal } from './models.js';
import { baseName, isSceneFile, matchSurface, type SurfacePattern } from './surfaces.js';

export const DEFAULT_MAX_FILES = 20_000;
export const MAX_MONETIZABLE = 20;
export const MAX_SCENE_FILES_REPORTED = 50;

/**
 * Directories that never contain source the creator wants counted. Engine caches are the big one:
 * a Godot `Library/` or Unity `Library/` can hold hundreds of thousands of files on its own.
 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'library',
  'temp',
  'build',
  'builds',
  'dist',
  '.nuxt',
  '.output',
  '.next',
  'obj',
  'binaries',
  'saved',
  'logs',
  'intermediate',
  'deriveddatacache',
  '.vs',
  '.idea',
  '.vscode',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tga',
  '.psd',
  '.wav',
  '.ogg',
  '.mp3',
  '.flac',
  '.mp4',
  '.webm',
  '.mov',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.dll',
  '.so',
  '.dylib',
  '.exe',
  '.pdb',
  '.a',
  '.lib',
  '.zip',
  '.7z',
  '.gz',
  '.pak',
  '.uasset',
  '.umap',
  '.resS',
  '.blend',
  '.fbx',
  '.glb',
  '.gltf',
  '.import',
  '.bak',
  '.tmp',
]);

export interface WalkResult {
  files: FoundFileLite[];
  truncated: boolean;
  /** Directories skipped because they were on the ignore list, relative to the root. */
  ignoredDirs: string[];
  /**
   * Every directory name present in the tree, lowercased. `Assets/` is empty by itself, so this
   * is what lets Unity detection confirm a project root without depending on any file inside it.
   */
  dirNames: Set<string>;
}

interface FoundFileLite {
  path: string;
  name: string;
  ext: string;
  size: number | null;
}

export interface Counts {
  scenes: number | null;
  surfaces: number | null;
  monetizableObjects: string[];
  /** Which files produced each monetizable object; feeds `propose_items` rationale. */
  surfaceSources: Array<{ id: string; file: string; slot?: string; kind: SurfacePattern['kind'] }>;
  sceneFiles: string[];
}

export interface ScanOptions {
  /** Absolute or relative project path; resolved against `baseDir` when relative. */
  path: string;
  baseDir: string;
  /** Force an engine instead of guessing. */
  engine?: Engine;
  maxFiles?: number;
  /** Overrides the hard-coded surface patterns (tests use this). */
  patterns?: true;
}

/**
 * Walks the project, detects the engine, and counts scenes and monetisation surfaces.
 *
 * Every count is derived from files actually seen. When the traversal cap is hit the counts become
 * lower bounds and `truncated` is set, so callers can label them honestly instead of guessing.
 */
export async function scanProject(options: ScanOptions): Promise<ScanReport> {
  const root = await resolveProjectRoot(options.path, options.baseDir);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const walk = await walkProject(root, maxFiles);
  const notes: string[] = [];
  const signals: ScanSignal[] = [];

  const byPath = new Map<string, FoundFileLite>();
  const byExt = new Map<string, FoundFileLite[]>();
  for (const file of walk.files) {
    byPath.set(file.path.toLowerCase(), file);
    const bucket = byExt.get(file.ext) ?? [];
    bucket.push(file);
    byExt.set(file.ext, bucket);
  }

  const readFileAt = async (file: FoundFileLite): Promise<string | null> => {
    if (file.size !== null && file.size > 2 * 1024 * 1024) return null;
    try {
      return await readFile(join(root, file.path), 'utf8');
    } catch {
      return null;
    }
  };

  // Pre-load the marker files that detection may need; they are few and small.
  const cachedText = new Map<string, string>();
  const cachedJson = new Map<string, Record<string, unknown> | null>();
  for (const marker of ['projectsettings/projectversion.txt', 'project.godot', 'package.json', 'config/defaultengine.ini']) {
    const file = byPath.get(marker);
    if (!file) continue;
    const text = await readFileAt(file);
    if (text === null) continue;
    cachedText.set(file.path, text);
    if (file.ext === '.json') {
      try {
        const parsed = JSON.parse(text) as unknown;
        cachedJson.set(file.path, parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
      } catch {
        notes.push(`${file.path} is not valid JSON, so its dependencies could not be read.`);
        cachedJson.set(file.path, null);
      }
    }
  }
  for (const marker of walk.files.filter((file) => file.ext === '.uproject').slice(0, 3)) {
    const text = await readFileAt(marker);
    if (text === null) continue;
    cachedText.set(marker.path, text);
    try {
      const parsed = JSON.parse(text) as unknown;
      cachedJson.set(marker.path, parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null);
    } catch {
      cachedJson.set(marker.path, null);
    }
  }

  let detection: Detection;
  if (options.engine) {
    detection = { engine: options.engine, signals: [], notes: [] };
    notes.push(`Engine was passed explicitly as "${options.engine}"; automatic detection was skipped.`);
  } else {
    detection = detectEngine({
      find: (lowerPath) => byPath.get(lowerPath),
      arch: process.platform,
      readText: (file) => cachedText.get(file.path) ?? null,
      readJson: (file) => cachedJson.get(file.path) ?? null,
      byExt: (ext) => byExt.get(ext) ?? [],
    });
  }
  signals.push(...detection.signals);
  notes.push(...detection.notes);

  const counts = countContent(walk.files as Array<{ path: string; name: string; ext: string }>);
  if (walk.truncated) {
    notes.push(
      `Traversal stopped after ${maxFiles} files, so every count below is a lower bound ("at least N"). ` +
        'Point the tool at a narrower path to get exact numbers.',
    );
  }
  if (counts.scenes === 0) {
    notes.push('No scene files were found. scenes/surfaces were omitted rather than reported as 0, so the API does not store a misleading zero.');
  }
  const scenesValue = counts.scenes === 0 ? undefined : counts.scenes;
  const surfacesValue = counts.surfaces && counts.surfaces > 0 ? counts.surfaces : undefined;
  const report: ScanReport = {
    engine: detection.engine,
    ...(detection.engineVersion ? { engineVersion: detection.engineVersion } : {}),
    ...(scenesValue !== undefined ? { scenes: scenesValue } : {}),
    ...(surfacesValue !== undefined ? { surfaces: surfacesValue } : {}),
    ...(counts.monetizableObjects.length ? { monetizableObjects: counts.monetizableObjects } : {}),
    path: root,
    signals,
    filesVisited: walk.files.length,
    truncated: walk.truncated,
    notes,
    sceneFiles: counts.sceneFiles.slice(0, MAX_SCENE_FILES_REPORTED),
  };
  return report;
}

/** The subset of the report that `/sdk/v1/publish/jobs/:id/steps/scan_project` accepts. */
export function toStepInput(report: ScanReport): Record<string, unknown> {
  const input: Record<string, unknown> = { engine: report.engine };
  if (report.engineVersion) input.engineVersion = report.engineVersion;
  if (report.scenes !== undefined) input.scenes = report.scenes;
  if (report.surfaces !== undefined) input.surfaces = report.surfaces;
  if (report.monetizableObjects?.length) input.monetizableObjects = report.monetizableObjects;
  return input;
}

export interface ContentCounts {
  scenes: number;
  surfaces: number;
  monetizableObjects: string[];
  surfaceSources: Array<{ id: string; file: string; slot?: string; kind: SurfacePattern['kind'] }>;
  sceneFiles: string[];
}

/**
 * Counts scenes and surfaces from the file list. Deduped by normalised asset name so `shop.tscn`
 * and `shop.ts` are one surface, and capped at 20 identifiers.
 */
export function countContent(files: Array<{ path: string; name: string; ext: string }>): ContentCounts {
  const sceneFiles: string[] = [];
  const surfaceById = new Map<string, { id: string; file: string; slot?: string; kind: SurfacePattern['kind'] }>();

  for (const file of files) {
    if (isSceneFile(file.path)) sceneFiles.push(file.path);

    if (BINARY_EXT.has(file.ext)) continue;
    const match = matchSurface(file.path);
    if (!match) continue;
    const id = baseName(file.path);
    const normalized = normalizeIdentifier(id);
    if (!normalized) continue;
    const key = normalized;
    const existing = surfaceById.get(key);
    // Prefer the scene file as the cited source: it is the asset a creator recognises.
    if (!existing || (isSceneFile(file.path) && !isSceneFile(existing.file))) {
      surfaceById.set(key, { id: normalized, file: file.path, ...(match.slot ? { slot: match.slot } : {}), kind: match.kind });
    }
  }

  const surfaceSources = [...surfaceById.values()].sort((a, b) => a.file.localeCompare(b.file));
  const all = surfaceSources.map((entry) => entry.id);
  const capped = all.slice(0, MAX_MONETIZABLE);
  return {
    scenes: sceneFiles.length,
    surfaces: surfaceSources.length,
    monetizableObjects: capped,
    surfaceSources: surfaceSources.slice(0, MAX_MONETIZABLE),
    sceneFiles: sceneFiles.sort(),
  };
}

function normalizeIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

export async function resolveProjectRoot(inputedPath: string, baseDir: string): Promise<string> {
  const target = isAbsolute(inputedPath) ? inputedPath : resolve(baseDir, inputedPath);
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new ToolError(
      code === 'ENOENT' ? `Project path does not exist: ${target}` : `Cannot read project path ${target} (${code ?? 'unknown error'})`,
      'path_not_found',
      'Pass an absolute `path` argument pointing at the game source directory (the folder containing project.godot, Assets/, or index.html).',
    );
  }
  if (!info.isDirectory()) {
    throw new ToolError(`Project path is not a directory: ${target}`, 'path_not_directory', 'Pass the directory that contains the game source, not a file.');
  }
  return target;
}

/**
 * Breadth-first walk with a hard file budget. Symlinks are not followed: a link back up the tree
 * would make the walk unbounded, and builds are usually reached through junctions.
 */
export async function walkProject(root: string, maxFiles: number): Promise<WalkResult> {
  const files: FoundFileLite[] = [];
  const ignoredDirs: string[] = [];
  const dirNames = new Set<string>();
  const queue: string[] = [''];
  let truncated = false;

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const absolute = dir ? join(root, dir) : root;
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relativePath = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        dirNames.add(lower);
        if (IGNORED_DIRS.has(lower)) {
          ignoredDirs.push(relativePath);
          continue;
        }
        queue.push(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const dot = entry.name.lastIndexOf('.');
      files.push({
        path: relativePath,
        name: entry.name.toLowerCase(),
        ext: dot > 0 ? entry.name.slice(dot).toLowerCase() : '',
        size: await sizeOf(join(root, relativePath)),
      });
    }
    if (truncated) break;
  }

  return { files, truncated, ignoredDirs, dirNames };
}

async function sizeOf(absolutePath: string): Promise<number | null> {
  try {
    const info = await stat(absolutePath);
    return info.size;
  } catch {
    return null;
  }
}

/** Exposed for `sverse_preview_sdk`, which needs file existence without a full scan. */
export async function fileExists(root: string, relativePath: string): Promise<boolean> {
  try {
    const handle = await open(join(root, relativePath), 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/** Converts an absolute path to the forward-slash relative form used in reports. */
export function toRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/');
}

export type { FoundFileLite };
