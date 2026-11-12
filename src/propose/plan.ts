import type { ScanReport } from '../scan/models.js';
import { matchSurface } from '../scan/surfaces.js';
import { chooseSchema, type ItemKind, type Schemas } from './schemas.js';

/**
 * Price bands in SRV *units* (6 decimals, so these are micro-SRV):
 * `120000000` = 120 SRV, `240000000` = 240 SRV, `15000000` = 15 SRV.
 * Money is carried as integer strings everywhere — never `Number` (spec/08 §5).
 */
export const PRICE_BANDS = {
  bundle: '120000000',
  pass: '240000000',
  cosmeticLow: '60000000',
  cosmeticHigh: '95000000',
  consumable: '15000000',
} as const;

export interface DraftItem {
  sku: string;
  name: string;
  kind: ItemKind;
  priceUnits: string;
  description?: string;
  slot?: string;
  schemaId?: string;
  interopTier?: string;
  traits?: Record<string, unknown>;
  supplyMax?: number | null;
  emoji?: string;
}

export interface DraftRationale {
  sku: string;
  /** The file(s) that justified this item. Empty for the two baseline items. */
  sources: string[];
  /** What the pricing and kind decision was based on. */
  reason: string;
}

export interface DraftPlan {
  draft: DraftItem[];
  rationale: DraftRationale[];
  /** True when the scan produced no usable monetisation signal; only the two baselines were emitted. */
  noSignalDetected: boolean;
  /** Plain-language statement of what the plan is based on; surfaced to the model. */
  summary: string;
}

export interface PlanOptions {
  schemas: Schemas;
  /** Game title used to name baseline items. */
  gameTitle: string;
}

interface SlotSignal {
  slot: string;
  file: string;
}

/**
 * Turns a scan into a catalogue draft. Deterministic and documented: no model call, so the same
 * project always produces the same draft and every item can be traced to the file that justified it.
 *
 * Rules:
 *  1. Always emit a `bundle` ("Starter Pack") and a `pass` ("Season Pass") — the two products every
 *     game can sell, and the two the reference agent also produced.
 *  2. Emit one `cosmetic` per distinct slot the scan found, max 3.
 *  3. Emit one `consumable` when a chest/loot/currency surface exists.
 *  4. Never pad to a round number and never invent a slot that no file supports.
 */
export function planDraft(scan: ScanReport, options: PlanOptions): DraftPlan {
  const draft: DraftItem[] = [];
  const rationale: DraftRationale[] = [];
  const scenes = scan.surfaces ?? 0;
  const title = options.gameTitle.trim() || 'Untitled';

  const push = (item: DraftItem, reason: string, sources: string[]): void => {
    const choice = chooseSchema(options.schemas, item.kind, item.slot);
    const enriched: DraftItem = { ...item };
    if (choice.schemaId) enriched.schemaId = choice.schemaId;
    if (choice.interopTier) enriched.interopTier = choice.interopTier;
    if (item.kind === 'cosmetic' && item.slot) {
      enriched.traits = { slot: item.slot, rarity: 'rare', ...(item.traits ?? {}) };
      enriched.slot = item.slot;
    }
    if (choice.note) reason = `${reason}. ${choice.note}`;
    draft.push(enriched);
    rationale.push({ sku: enriched.sku, sources, reason: `${reason}; schema: ${choice.schemaId ?? 'none'} at ${enriched.interopTier ?? 'T0'}` });
  };

  push(
    {
      sku: 'starter_pack',
      name: `${title} Starter Pack`,
      kind: 'bundle',
      priceUnits: PRICE_BANDS.bundle,
      description: 'Entry bundle: starting currency and one cosmetic.',
      emoji: '📦',
    },
    `baseline product — every game can sell a starter bundle (price band ${PRICE_BANDS.bundle} units = 120 SRV)`,
    [],
  );

  push(
    {
      sku: 'season_pass',
      name: `${title} Season Pass`,
      kind: 'pass',
      priceUnits: PRICE_BANDS.pass,
      description: 'Season-long reward track.',
      emoji: '🎟️',
    },
    `baseline product — season passes are the highest-value non-cosmetic (price band ${PRICE_BANDS.pass} units = 240 SRV)`,
    [],
  );

  const slots = slotSignals(scan);
  const cosmeticSources = [...new Set(scan.monetizableObjects ?? [])];
  if (slots.length > 0) {
    slots.slice(0, 3).forEach((entry, index) => {
      const price = cosmeticPrice(index);
      push(
        {
          sku: `cosmetic_${entry.slot}`,
          name: `${title} ${titleCase(entry.slot)} Cosmetic`,
          kind: 'cosmetic',
          priceUnits: price,
          slot: entry.slot,
          description: `Cosmetic for the ${entry.slot} slot.`,
          emoji: '🧥',
        },
        `cosmetic slot "${entry.slot}" observed (price band ${price} units)`,
        [entry.file],
      );
    });
  } else if (scenes > 0) {
    // A game with shop/store scenes but no slot information still sells cosmetics: emit one
    // slot-less cosmetic so the catalogue is not just two bundles.
    const source = scan.signals.find((signal) => signal.file)?.file ?? scan.sceneFiles[0] ?? '';
    push(
      {
        sku: 'cosmetic_hero',
        name: `${title} Hero Skin`,
        kind: 'cosmetic',
        priceUnits: cosmeticPrice(0),
        description: 'Headline cosmetic.',
        emoji: '✨',
      },
      `surfaces were found but no slot could be derived from file names, so one un-slotted cosmetic is proposed (price band ${cosmeticPrice(0)} units)`,
      source ? [source] : [],
    );
  }

  const loot = lootSurface(scan);
  if (loot) {
    push(
      {
        sku: 'loot_chest',
        name: `${title} Loot Chest`,
        kind: 'consumable',
        priceUnits: PRICE_BANDS.consumable,
        description: 'Consumable chest.',
        emoji: '🎁',
      },
      `chest/loot/currency surface detected (price band ${PRICE_BANDS.consumable} units = 15 SRV)`,
      [loot],
    );
  }

  const noSignalDetected = scenes === 0 && cosmeticSources.length === 0;
  const summary = noSignalDetected
    ? 'No monetizable surface was detected in the scanned files, so only the two baseline products (Starter Pack, Season Pass) are proposed. ' +
      'Review them or edit the draft before approving. This is not a guess about your game — it is the minimum catalogue every game can sell.'
    : `Plan derived from ${scenes} monetizable surface file(s) in the project: ` +
      `${slots.length > 0 ? `cosmetic slot(s) ${slots.map((entry) => entry.slot).join(', ')}` : 'no cosmetic slot'}${loot ? '; a loot/currency surface' : ''}. ` +
      'Every item cites the file that justified it in `rationale`.';

  return { draft, rationale, noSignalDetected, summary };
}

function slotSignals(scan: ScanReport): SlotSignal[] {
  const bySlot = new Map<string, string>();
  for (const file of scan.sceneFiles) {
    const match = matchSurface(file);
    if (!match?.slot) continue;
    if (!bySlot.has(match.slot)) bySlot.set(match.slot, file);
  }
  // Identifier-only surfaces (`monetizableObjects` entries) carry no directory, so cite the id itself.
  for (const id of scan.monetizableObjects ?? []) {
    const match = matchSurface(id);
    if (!match?.slot || bySlot.has(match.slot)) continue;
    bySlot.set(match.slot, id);
  }
  return [...bySlot.entries()].map(([slot, file]) => ({ slot, file }));
}

function lootSurface(scan: ScanReport): string | undefined {
  for (const id of scan.monetizableObjects ?? []) {
    const match = matchSurface(id);
    if (match && match.kind === 'consumable') return id;
  }
  return undefined;
}

/** Third cosmetic is cheaper than the first: 95 SRV, 77.5 SRV, 60 SRV — still integers. */
export function cosmeticPrice(index: number): string {
  const low = BigInt(PRICE_BANDS.cosmeticLow);
  const high = BigInt(PRICE_BANDS.cosmeticHigh);
  if (index <= 0) return PRICE_BANDS.cosmeticHigh;
  if (index >= 2) return PRICE_BANDS.cosmeticLow;
  return ((low + high) / 2n).toString();
}

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
