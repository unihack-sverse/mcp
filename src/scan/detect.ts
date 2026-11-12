import type { Engine, ScanSignal } from './models.js';

/**
 * A file discovered by the walk, reduced to what the heuristics need. Names are relative to the
 * project root with forward slashes so the result is machine-independent.
 */
export interface FoundFile {
  /** Path relative to the project root, forward slashes. */
  path: string;
  /** Lowercased `basename`. */
  name: string;
  /** Lowercased extension including the dot, e.g. `.tscn`; empty when the file has none. */
  ext: string;
  /** Size in bytes; `null` when `stat` failed (permissions, race with a delete). */
  size: number | null;
}

export interface Detection {
  engine: Engine;
  engineVersion?: string;
  signals: ScanSignal[];
  /** Set when detection was ambiguous or could not read the marker file. */
  notes: string[];
}

interface Marker {
  engine: Engine;
  path: string;
  reason: string;
}

const MARKERS: Marker[] = [
  { engine: 'unity', path: 'ProjectSettings/ProjectVersion.txt', reason: 'Unity project descriptor' },
  { engine: 'godot', path: 'project.godot', reason: 'Godot project descriptor' },
  { engine: 'unreal', path: 'DefaultEngine.ini', reason: 'Unreal Engine config' },
  { engine: 'unreal', path: 'Config/DefaultEngine.ini', reason: 'Unreal Engine config' },
];

const JS_ENGINE_DEPS = ['phaser', 'pixi.js', 'pixi', 'three', 'babylonjs', 'excalibur', 'melonjs', 'pixi.js-legacy'];
const JS_FORMAT_DEPS = ['@sverse/sverse-js'];

export interface DetectInput {
  /** Case-sensitive lookup by lowercase relative path; returns the file when present. */
  find: (lowerPath: string) => FoundFile | undefined;
  arch: string;
  /** Contents of a text marker file, or `null` when unreadable. */
  readText: (file: FoundFile) => string | null;
  /** Reads a package.json and returns its parsed object, or `null`. */
  readJson: (file: FoundFile) => Record<string, unknown> | null;
  /** All files whose path ends with one of the given extensions. */
  byExt: (ext: string) => FoundFile[];
}

/**
 * Engine detection, highest-confidence marker first. Reads marker files rather than sniffing the
 * extension census alone: a Godot project with one stray `.unity` file must still be Godot.
 *
 * When nothing matches, the answer is `other` and the notes say what was looked for — a guess here
 * would poison every step downstream (schemas, SDK choice, counts).
 */
export function detectEngine(input: DetectInput): Detection {
  const signals: ScanSignal[] = [];
  const notes: string[] = [];

  const unityMarker = input.find('projectsettings/projectversion.txt');
  if (unityMarker) {
    signals.push({ file: unityMarker.path, reason: 'Unity project descriptor' });
    const text = input.readText(unityMarker);
    const version = parseUnityVersion(text);
    const notesForUnity: string[] = [];
    if (!version) notesForUnity.push(`${unityMarker.path} did not contain m_EditorVersion, so engineVersion was omitted.`);
    if (!input.find('assets/') && !hasAssetsDir(input)) notesForUnity.push('No Assets/ directory found; this may not be a Unity project root.');
    return { engine: 'unity', ...(version ? { engineVersion: version } : {}), signals, notes: notesForUnity };
  }

  const godotMarker = input.find('project.godot');
  if (godotMarker) {
    signals.push({ file: godotMarker.path, reason: 'Godot project descriptor' });
    const text = input.readText(godotMarker);
    const version = parseGodotMajor(text);
    const notesForGodot: string[] = [];
    if (version) {
      notesForGodot.push(
        `engineVersion "${version}" is the Godot major only: project.godot records config_version, not the patch version.`,
      );
    } else if (text === null) {
      notesForGodot.push(`${godotMarker.path} could not be read, so engineVersion was omitted.`);
    } else {
      notesForGodot.push(`${godotMarker.path} has no parsable config_version, so engineVersion was omitted.`);
    }
    return { engine: 'godot', ...(version ? { engineVersion: version } : {}), signals, notes: notesForGodot };
  }

  const unrealMarker = MARKERS.filter((marker) => marker.engine === 'unreal').map((marker) => input.find(marker.path.toLowerCase())).find(Boolean);
  const uproject = input.byExt('.uproject')[0];
  if (unrealMarker || uproject) {
    const marker = unrealMarker ?? uproject;
    if (marker) signals.push({ file: marker.path, reason: unrealmReason(marker) });
    const notesForUnreal: string[] = [];
    if (uproject) {
      const text = input.readJson(uproject);
      const engineAssoc = text?.EngineAssociation;
      if (typeof engineAssoc === 'string' && engineAssoc) {
        signals.push({ file: uproject.path, reason: `EngineAssociation ${engineAssoc}` });
        return { engine: 'unreal', engineVersion: engineAssoc.slice(0, 20), signals, notes: notesForUnreal };
      }
    }
    notesForUnreal.push('Unreal project detected but no EngineAssociation, so engineVersion was omitted.');
    return { engine: 'unreal', signals, notes: notesForUnreal };
  }

  const js = detectJs(input);
  if (js) return js;

  const census = [
    ['.tscn', 'Godot scene'],
    ['.gd', 'GDScript'],
    ['.unity', 'Unity scene'],
    ['.umap', 'Unreal map'],
  ] as const;
  const seen = census
    .map(([ext, label]) => ({ ext, label, count: input.byExt(ext).length }))
    .filter((entry) => entry.count > 0);
  if (seen.length > 0) {
    notes.push(
      `No engine descriptor was found, but the project contains ${seen.map((entry) => `${entry.count} ${entry.label} file(s) (${entry.ext})`).join(', ')}. ` +
        'Pass the `engine` argument explicitly to sverse_scan_project.',
    );
  } else {
    notes.push(
      'No engine descriptor was found. Looked for ProjectSettings/ProjectVersion.txt (Unity), project.godot (Godot), ' +
        '*.uproject or Config/DefaultEngine.ini (Unreal), a game framework dependency in package.json (js), and an index.html.',
    );
  }
  return { engine: 'other', signals, notes };
}

function detectJs(input: DetectInput): Detection | null {
  const pkg = input.find('package.json');
  if (pkg) {
    const json = input.readJson(pkg);
    if (json) {
      const deps = {
        ...(asRecord(json.dependencies) ?? {}),
        ...(asRecord(json.devDependencies) ?? {}),
      };
      const hasFormat = JS_FORMAT_DEPS.some((name) => name in deps);
      const framework = JS_ENGINE_DEPS.find((name) => name in deps);
      if (framework || hasFormat) {
        return {
          engine: 'js',
          signals: [
            { file: pkg.path, reason: `package.json dependency ${framework ?? JS_FORMAT_DEPS[0]}` },
          ],
          notes: [],
        };
      }
    }
  }
  const index = input.find('index.html');
  const jsFiles = input.byExt('.js').length + input.byExt('.mjs').length;
  if (index && jsFiles > 0) {
    return {
      engine: 'js',
      signals: [
        { file: index.path, reason: 'index.html' },
        { file: '*.js', reason: `${jsFiles} JavaScript file(s)` },
      ],
      notes: ['No known game framework dependency was found; treating this as a browser (js) game because of index.html + JavaScript files.'],
    };
  }
  return null;
}

/** `m_EditorVersion: 2022.3.10f1` (also tolerates `m_EditorVersionWithRevision`). */
export function parseUnityVersion(text: string | null): string | undefined {
  if (!text) return undefined;
  const match = /^\s*m_EditorVersion\s*:\s*(\S+)/m.exec(text);
  return match?.[1]?.slice(0, 20);
}

/**
 * Godot 4 writes `config_version=5`, Godot 3 writes `config_version=4`. The file has no patch
 * version, so the major is the most honest value we can report.
 */
export function parseGodotMajor(text: string | null): string | undefined {
  if (!text) return undefined;
  const features = /config\/features\s*=\s*PackedStringArray\(\s*"([^"]+)"/.exec(text);
  if (features?.[1]) {
    const major = /^(\d+)\./.exec(features[1]);
    if (major?.[1]) return major[1];
    if (/^\d+$/.test(features[1])) return features[1];
  }
  const configVersion = /^\s*config_version\s*=\s*(\d+)/m.exec(text);
  if (configVersion?.[1] === '5') return '4';
  if (configVersion?.[1] === '3' || configVersion?.[1] === '4') return '3';
  return undefined;
}

function unrealmReason(file: FoundFile): string {
  return file.ext === '.uproject' ? 'Unreal project descriptor' : 'Unreal Engine config';
}

function hasAssetsDir(input: DetectInput): boolean {
  return input.byExt('.meta').length > 0 || input.find('assets') !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
