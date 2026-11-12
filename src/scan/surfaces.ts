export interface SurfacePattern {
  /** Stable identifier reported back to the model. */
  id: string;
  /** Matches against the asset name with separators normalised to `_`. */
  pattern: RegExp;
  /** Cosmetic slot implied by this surface, when any. Used by `propose_items`. */
  slot?: string;
  /** Item kind this surface justifies. */
  kind: 'cosmetic' | 'pass' | 'consumable' | 'bundle';
}

/**
 * Ordered so the most specific identifier wins: `battle_pass` is a pass, not a cosmetic, even
 * though it also matches the generic `pass` token.
 */
export const SURFACE_PATTERNS: SurfacePattern[] = [
  { id: 'battle_pass', pattern: /battle_?pass/, kind: 'pass' },
  { id: 'season_pass', pattern: /season_?pass/, kind: 'pass' },
  { id: 'pass', pattern: /(^|_)pass($|_)/, kind: 'pass' },
  { id: 'starter_bundle', pattern: /starter_?(pack|bundle)/, kind: 'bundle' },
  { id: 'bundle', pattern: /bundle/, kind: 'bundle' },
  { id: 'chest', pattern: /chest/, kind: 'consumable' },
  { id: 'loot', pattern: /loot/, kind: 'consumable' },
  { id: 'skin', pattern: /skin/, kind: 'cosmetic' },
  { id: 'cosmetic', pattern: /cosmetic/, kind: 'cosmetic' },
  { id: 'outfit', pattern: /outfit/, kind: 'cosmetic', slot: 'torso' },
  { id: 'shop', pattern: /shop|store/, kind: 'bundle' },
  { id: 'gem', pattern: /gem/, kind: 'consumable' },
  { id: 'diamond', pattern: /diamond/, kind: 'consumable' },
  { id: 'coin', pattern: /coin/, kind: 'consumable' },
  { id: 'currency', pattern: /currency/, kind: 'consumable' },
];

/** Substrings that mark a scene/asset as a monetisation surface. Exported for the README's honesty table. */
export const SURFACE_TOKENS = [
  'shop',
  'store',
  'cosmetic',
  'skin',
  'bundle',
  'pass',
  'battlepass',
  'diamond',
  'coin',
  'gem',
  'currency',
  'loot',
  'chest',
  'outfit',
  'starter',
];

/** `Ashmaw-Jacket Shop.tscn` → `ashmaw_jacket_shop`. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Strips the final extension so `shop.tscn` and `shop.unity` both normalise to `shop`. */
export function baseName(filePath: string): string {
  const last = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

export function matchSurface(filePath: string): SurfacePattern | null {
  const lower = normalizeName(filePath);
  if (!lower) return null;
  for (const entry of SURFACE_PATTERNS) {
    if (entry.pattern.test(lower)) return entry;
  }
  return null;
}

/**
 * Scene extensions per engine. Counting all of them means a Unity project that ships a Godot
 * sub-project still reports every scene the creator has.
 */
export const SCENE_EXTENSIONS = ['.unity', '.tscn', '.umap', '.scene', '.gdscene'] as const;

/** Files that describe a project but are not scenes, used to avoid counting descriptors twice. */
export function isSceneFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SCENE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
