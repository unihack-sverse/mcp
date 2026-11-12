import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import type { Config } from './config.js';
import { fromApiError, messageFor, type ApiErrorBody, type ErrorContext } from './errors.js';

/** A publish job as returned by `mapJob` in `backend-v2/src/modules/publish/services/publish.service.js`. */
export interface PublishStep {
  index: number;
  step: string;
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  requiresApproval: boolean;
  output: unknown;
  error: { code: string; message: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PublishJob {
  id: string;
  mode: 'ai' | 'manual';
  status: 'running' | 'done' | 'failed';
  gameId: string | null;
  game: { id: string; slug: string; title: string; status: string; blockedReason?: string; tokenizationLevel?: string } | null;
  catalogApproved: boolean;
  draftCatalog: DraftCatalogItem[];
  steps: PublishStep[];
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  createdAt: string;
}

/** A catalogue entry as stored on the job: `normalizeDraft` output plus `priceSrv`. */
export interface DraftCatalogItem {
  sku: string;
  name: string;
  kind: string;
  priceUnits: string;
  priceSrv?: string;
  description?: string;
  slot?: string;
  schemaId?: string;
  interopTier?: string;
  traits?: Record<string, unknown>;
  supplyMax?: number | null;
  emoji?: string;
}

export interface MeResponse {
  keyId: string;
  scopes: string[];
  studio: { id: string; handle: string };
  game: { id: string; slug: string; title: string; status: string } | null;
  deedSignature: string;
}

export interface TraitSchema {
  id: string;
  schemaId: string;
  class: string;
  subclass: string;
  version: string;
  fields: Array<{ name: string; type: string; required?: boolean; values?: string[]; min?: number; max?: number }>;
  mutation: unknown;
  allowedInteropTiers: string[];
  status: string;
}

export interface ItemDefinition {
  id: string;
  sku: string;
  name: string;
  kind: string;
  priceUnits: string;
  priceSrv: string;
  status: string;
  schemaId: string | null;
  interopTier: string;
  slot: string | null;
}

export interface CreateJobInput {
  mode?: 'ai' | 'manual';
  gameId?: string;
  title?: string;
  genre?: string;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** Extra context merged into error messages (e.g. `blockingStep`, `jobId`). */
  errorContext?: ErrorContext;
  /** Bypass the JSON parse and return the raw response (used by health checks). */
  raw?: boolean;
}

/**
 * Minimal typed client for `/sdk/v1`. Every method maps API errors through `errors.ts` so a tool
 * never surfaces a bare HTTP status to the model.
 */
export class SverseClient {
  readonly apiUrl: string;

  constructor(private readonly config: Config) {
    this.apiUrl = config.apiUrl;
  }

  get consoleUrl(): string {
    return this.config.consoleUrl;
  }

  get projectDir(): string {
    return this.config.projectDir;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    // A pooled keep-alive socket can be closed by the server while idle (Express closes after 5s).
    // undici then fails the very next request with ECONNRESET even though nothing is wrong. Retrying
    // once on a connection-level error only — never on an HTTP error — is safe and idempotent.
    try {
      return await this.send<T>(path, options);
    } catch (error) {
      if (!isConnectionReset(error)) throw error;
      return this.send<T>(path, options);
    }
  }

  private async send<T>(path: string, options: RequestOptions): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = (cause as { name?: string })?.name === 'AbortError';
      const underlying = (cause as { cause?: { code?: string; message?: string } })?.cause;
      const detail = [underlying?.code, underlying?.message].filter(Boolean).join(' ');
      throw new McpError(
        ErrorCode.InternalError,
        aborted
          ? `Request to ${url} timed out after ${this.config.requestTimeoutMs}ms. The backend may be hung or the route is slow; no retry was made.`
          : `${messageFor('network_error', undefined, { url })}${detail ? ` Underlying error: ${detail}.` : ''}`,
        { code: 'network_error', url, cause: detail || String(cause) },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const body = (parsed as { error?: ApiErrorBody } | undefined)?.error;
      const requestId = body?.requestId ?? response.headers.get('X-Request-Id') ?? undefined;
      const blockingStep = extractBlockingStep(body);
      throw fromApiError(
        body ?? { code: `http_${response.status}`, message: (text || response.statusText).slice(0, 300) },
        { ...options.errorContext, url, requestId, blockingStep: options.errorContext?.blockingStep ?? blockingStep },
      );
    }

    if (text && parsed === undefined) {
      throw new McpError(ErrorCode.InternalError, `The API returned a non-JSON body from ${url}. Check SVERSE_API_URL: ${text.slice(0, 200)}`, {
        code: 'invalid_response',
        url,
      });
    }
    return parsed as T;
  }

  private async data<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const body = await this.request<{ data: T }>(path, options);
    return body?.data as T;
  }

  async me(): Promise<MeResponse> {
    return this.data<MeResponse>('/sdk/v1/me');
  }

  async listSchemas(): Promise<TraitSchema[]> {
    const body = await this.request<{ data: TraitSchema[] }>('/sdk/v1/schemas');
    return body?.data ?? [];
  }

  async listItems(): Promise<ItemDefinition[]> {
    const body = await this.request<{ data: ItemDefinition[] }>('/sdk/v1/items');
    return body?.data ?? [];
  }

  async createJob(input: CreateJobInput): Promise<PublishJob> {
    return this.data<PublishJob>('/sdk/v1/publish/jobs', { method: 'POST', body: input });
  }

  async getJob(jobId: string): Promise<PublishJob> {
    return this.data<PublishJob>(`/sdk/v1/publish/jobs/${encodeURIComponent(jobId)}`, { errorContext: { jobId } });
  }

  async runStep(jobId: string, step: string, input: unknown = {}): Promise<PublishJob> {
    return this.data<PublishJob>(`/sdk/v1/publish/jobs/${encodeURIComponent(jobId)}/steps/${encodeURIComponent(step)}`, {
      method: 'POST',
      body: input ?? {},
      errorContext: { jobId, blockingStep: undefined },
    });
  }
}

/**
 * True only for transport-level faults that a fresh connection would fix. HTTP status errors and
 * our own McpErrors are never retried.
 */
function isConnectionReset(error: unknown): boolean {
  if (error instanceof McpError) {
    const data = error.data as { code?: string; cause?: string } | undefined;
    return data?.code === 'network_error' && /ECONNRESET|EPIPE|socket hang up/i.test(String(data.cause ?? ''));
  }
  return false;
}

/** `step_out_of_order` carries the blocking step in `details[].message` — e.g. "propose_items must finish first." */
function extractBlockingStep(body: ApiErrorBody | undefined): string | undefined {
  if (!body || body.code !== 'step_out_of_order') return undefined;
  const details = body.details;
  const candidates: string[] = [];
  if (Array.isArray(details)) {
    for (const entry of details) {
      if (typeof entry === 'string') candidates.push(entry);
      else if (entry && typeof entry === 'object' && typeof (entry as { message?: unknown }).message === 'string') {
        candidates.push((entry as { message: string }).message);
      }
    }
  }
  for (const candidate of [body.message, ...candidates]) {
    const match = /^([a-z_]+) must finish first/.exec(candidate);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
