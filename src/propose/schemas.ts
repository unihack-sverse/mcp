import type { SverseClient, TraitSchema } from '../client.js';

/** Item kinds the API accepts (`ITEM_KINDS` in `backend-v2/src/config/constants.js`). */
export const ITEM_KINDS = ['cosmetic', 'bundle', 'pass', 'consumable', 'unlock', 'content', 'living'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const INTEROP_TIERS = ['T0', 'T1', 'T2', 'T3'] as const;

/**
 * Preferred schema per kind, most specific first. `map_to_schema` on the server falls back to its own
 * DEFAULT_SCHEMA when `schemaId` is null, but only `bundle`, `cosmetic`, `living` and `content` have one —
 * so items of other kinds must be matched from the live registry here.
 */
const PREFERRED_SCHEMAS: Partial<Record<ItemKind, string[]>> = {
  bundle: ['sts/bundle/v1'],
  cosmetic: ['sts/cosmetic/wearable/v1'],
  living: ['sts/weapon/melee/v1'],
  content: ['sts/content/chapter/v1'],
  consumable: ['sts/consumable/charge/v1'],
};

/** Tier a kind should request; the server clamps it to what the schema allows. */
const REQUESTED_TIER: Record<ItemKind, (typeof INTEROP_TIERS)[number]> = {
  cosmetic: 'T1',
  bundle: 'T2',
  living: 'T2',
  pass: 'T0',
  consumable: 'T0',
  unlock: 'T0',
  content: 'T0',
};

export interface Schemas {
  all: TraitSchema[];
  byId: Map<string, TraitSchema>;
}

export async function fetchSchemas(client: SverseClient): Promise<Schemas> {
  const all = await client.listSchemas();
  return { all, byId: new Map(all.map((schema) => [schema.schemaId, schema])) };
}

export interface SchemaChoice {
  schemaId?: string;
  interopTier?: string;
  /** Why this schema was chosen, or why none could be. Shown in `rationale`. */
  note?: string;
}

/**
 * Resolves a schema for an item kind from the live registry. `preferredSlot` narrows cosmetic
 * classes (wearable vs trail vs banner) using the slot the scan found.
 */
export function chooseSchema(schemas: Schemas, kind: ItemKind, preferredSlot?: string): SchemaChoice {
  const preferred = PREFERRED_SCHEMAS[kind] ?? [];

  if (kind === 'cosmetic' && preferredSlot) {
    const matching = schemas.all.filter(
      (schema) => schema.class === 'cosmetic' && Array.isArray(schema.fields) && schema.fields.some((field) => field.name === 'slot' && field.values?.includes(preferredSlot)),
    );
    const chosen = pickHighestTier(matching);
    if (chosen) return { schemaId: chosen.schemaId, interopTier: INTEROP_TIERS[Math.min(1, maxTier(chosen))], note: `cosmetic schema accepting slot "${preferredSlot}"` };
  }

  for (const schemaId of preferred) {
    const schema = schemas.byId.get(schemaId);
    if (schema?.status === 'active') {
      return { schemaId, interopTier: clampTier(schema, REQUESTED_TIER[kind]), note: `registered schema for kind "${kind}"` };
    }
  }

  const byClass = schemas.all.filter((schema) => schema.class === kind && schema.status === 'active');
  const chosen = pickHighestTier(byClass);
  if (chosen) {
    return { schemaId: chosen.schemaId, interopTier: clampTier(chosen, REQUESTED_TIER[kind]), note: `no canonical schema for "${kind}"; used ${chosen.schemaId} by class match` };
  }

  // `pass`, `unlock` and other kinds have no trait schema in the registry at all (the pass is a
  // non-transferable entitlement, not a portable object). That is a valid catalogue entry: the
  // server's map_to_schema leaves it unmapped at T0, which is correct rather than a defect.
  return {
    interopTier: 'T0',
    note: `no trait schema exists for kind "${kind}"; it stays portable-less (T0) by design — passes and unlocks are entitlements, not interop objects`,
  };
}

function pickHighestTier(schemas: TraitSchema[]): TraitSchema | undefined {
  return [...schemas].sort((a, b) => maxTier(b) - maxTier(a))[0];
}

/** Tier the schema allows, as a list index. */
export function maxTier(schema: TraitSchema): number {
  const allowed = schema.allowedInteropTiers?.length ? schema.allowedInteropTiers : ['T0'];
  return Math.max(0, ...allowed.map((tier) => INTEROP_TIERS.indexOf(tier as (typeof INTEROP_TIERS)[number])));
}

/** The highest tier both sides allow — mirrors `itemsService.resolveInteropTier` so client previews match the server. */
export function clampTier(schema: TraitSchema, requested: string): string {
  const requestedIndex = INTEROP_TIERS.indexOf(requested as (typeof INTEROP_TIERS)[number]);
  return INTEROP_TIERS[Math.min(Math.max(requestedIndex, 0), maxTier(schema))] ?? 'T0';
}
