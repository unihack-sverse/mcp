import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Structured result plus a plain-text rendering. Both `content` (shown in the transcript) and
 * `structuredContent` (typed, what the model reasons over) are returned: a tool that only returns
 * text loses the fields its description promises.
 */
export function textResult(summary: string, data: Record<string, unknown>): CallToolResult & { structuredContent: Record<string, unknown> } {
  return {
    content: [{ type: 'text', text: `${summary}\n\n${safeJson(data)}` }],
    structuredContent: { summary, data },
  };
}

/**
 * Shared output schema. Every tool returns `{ summary, data }`; `data` holds the typed fields, so a
 * client can check the schema without the tool having to redeclare each shape.
 */
export const OUTPUT_SCHEMA = { summary: z.string(), data: z.record(z.unknown()) };

export function errorResult(error: unknown): CallToolResult {
  if (error instanceof McpError) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
  if (error instanceof Error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
  return { content: [{ type: 'text', text: String(error) }], isError: true };
}

/** Routes every tool body through this so a thrown error becomes an `isError` result, not a protocol fault. */
export function guarded<Shape extends z.ZodRawShape>(
  _shape: Shape,
  fn: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<CallToolResult>,
): (args: z.objectOutputType<Shape, z.ZodTypeAny>, extra: unknown) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => (typeof current === 'bigint' ? current.toString() : current), 2);
}

/** Formats a whole-SRV price from integer micro-SRV units, e.g. "120000000" → "120 SRV". */
export function formatUnits(units: string | bigint): string {
  const value = typeof units === 'bigint' ? units : BigInt(units);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction} SRV` : `${whole} SRV`;
}
