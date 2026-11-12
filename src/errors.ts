import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * The API answers non-2xx with `{ error: { code, message, details, requestId } }`
 * (`backend-v2/src/middleware/error-handler.js`).
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export interface ErrorContext {
  /** Full request URL. */
  url?: string;
  /** API error code. */
  code?: string;
  /** `details[]` from the API, normally `{ field, issue }`. */
  details?: unknown;
  /** Request id from the API response, useful when asking for support. */
  requestId?: string;
  /** Blocking step for `step_out_of_order`. */
  blockingStep?: string;
  /** Job id for approval instructions. */
  jobId?: string;
  /** Console base URL for approval instructions. */
  consoleUrl?: string;
  /** Human-verification URL for domain verification errors. */
  verifyUrl?: string;
}

export function approvalInstructions(jobId: string, consoleUrl: string): string {
  const url = `${consoleUrl}/studio/publish?job=${encodeURIComponent(jobId)}`;
  return (
    `Blocked: the catalogue needs human approval before items can be written. ` +
    `Ask the creator to open ${url} and approve the proposed catalogue. ` +
    'Nothing has been written to the game. ' +
    'An API key cannot approve: approval is a human act (UC-19 §5). ' +
    'Call sverse_get_job afterwards — it reports whether the approval landed.'
  );
}

/** Deterministic, actionable message per API error code. Falls back to the server message. */
export function messageFor(code: string | undefined, serverMessage: string | undefined, ctx: ErrorContext = {}): string {
  switch (code) {
    case 'invalid_api_key':
      return (
        'The API key was rejected. Check that SVERSE_API_KEY is copied in full and has not been revoked. ' +
        'Keys look like sk_live_<32 alphanumerics>; the plaintext is shown only once at creation.'
      );
    case 'insufficient_scope':
      return (
        'This key is missing the scope this call needs (publish, game, or read). ' +
        'Create a key whose scopes include "publish" in the studio settings and use that secret for publishing.'
      );
    case 'studio_suspended':
      return 'The studio owning this key is suspended, so the API refuses all calls. Contact support or resolve the studio status in the console.';
    case 'not_your_job':
      return (
        'This job does not belong to the studio or game this key is bound to. ' +
        'A game-bound key can only touch jobs for its own game; use a studio-level key or the matching job id.'
      );
    case 'not_your_game':
      return 'The key is not bound to that game and its studio does not own it. Bind the key to the game or omit gameId.';
    case 'game_binding_required':
      return 'This endpoint needs a game. Bind the API key to a game or pass gameId in the request.';
    case 'job_not_found':
      return 'No publish job exists with that id. Call sverse_scan_project to create one, or pass the id returned by a previous call.';
    case 'game_not_found':
      return 'No game exists with that id in this studio. Check the id from sverse_whoami or the console.';
    case 'step_not_found':
      return (
        'That step does not exist on this job. Valid steps: scan_project, propose_items, map_to_schema, ' +
        'create_item_pack, install_sdk, test_purchase, publish.'
      );
    case 'step_out_of_order':
      return `Steps run in a fixed order. ${ctx.blockingStep ? `"${ctx.blockingStep}" must finish first — ` : ''}call sverse_get_job and run the first step that is not done. A retry also clears all later steps.`;
    case 'catalog_not_approved':
      return ctx.jobId && ctx.consoleUrl ? approvalInstructions(ctx.jobId, ctx.consoleUrl) : 'catalog_not_approved';
    case 'human_approval_required':
      return ctx.jobId && ctx.consoleUrl
        ? approvalInstructions(ctx.jobId, ctx.consoleUrl)
        : 'Catalogue approval is human-only and cannot be performed with an API key (UC-19 §5).';
    case 'job_finished':
      return 'This job has already finished. Start a new job (sverse_scan_project) to publish further changes.';
    case 'invalid_step_input':
    case 'validation_failed': {
      const fields = formatDetails(ctx.details);
      return `The step input failed validation${fields ? `: ${fields}` : ''}. Fix the listed fields and retry.`;
    }
    case 'invalid_traits': {
      const fields = formatDetails(ctx.details);
      return `Item traits do not satisfy their schema${fields ? `: ${fields}` : ''}. Call sverse_propose_items to regenerate the draft.`;
    }
    case 'empty_catalog':
      return 'The job has no draft catalogue. Run sverse_propose_items (and create_item_pack needs an approved catalogue) first.';
    case 'sku_taken':
      return 'An item with that SKU already exists for this game. Use a different sku, or drop the "' + 'sku"' + ' field to let the server derive one.';
    case 'schema_not_active':
    case 'schema_not_found':
      return 'That trait schema does not exist or is not active. Pick a schemaId from GET /sdk/v1/schemas (sverse_propose_items does this for you).';
    case 'insufficient_funds':
      return 'The account does not have enough SRV for this operation. Top up the studio or player balance before retrying.';
    case 'rate_limited':
      return 'The API rate limit was hit (1200 requests/minute per key for /sdk/v1). Wait before retrying.';
    case 'unauthorized':
      return 'The API rejected the request as unauthenticated. Check that SVERSE_API_KEY is set and not revoked.';
    case 'forbidden':
      return 'The API refused this call for the current studio or game. Check key scopes and game binding.';
    case 'internal_error':
      return `The API failed unexpectedly${ctx.requestId ? ` (requestId ${ctx.requestId})` : ''}. Retry once; if it persists, quote the requestId.`;
    case 'route_not_found':
      return `The API has no such route: ${ctx.url ?? 'unknown URL'}. Check SVERSE_API_URL (default http://127.0.0.1:4000).`;
    case 'network_error':
      return (
        `Could not reach the Sverse API at ${ctx.url ?? 'the configured URL'}. ` +
        'Start the backend (cd backend-v2 && npm run dev) or fix SVERSE_API_URL. No retry was made.'
      );
    case 'human_verification_required':
      return `The operation needs a human verification step${ctx.verifyUrl ? `: open ${ctx.verifyUrl}` : ''}.`;
    default:
      if (serverMessage && serverMessage !== code) return serverMessage;
      return code ? `Sverse API error: ${code}` : 'The Sverse API request failed.';
  }
}

function formatDetails(details: unknown): string {
  if (!Array.isArray(details) || details.length === 0) return '';
  return details
    .slice(0, 8)
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const field = typeof record.field === 'string' ? record.field : '';
        const issue = typeof record.issue === 'string' ? record.issue : typeof record.message === 'string' ? record.message : '';
        if (field && issue) return `${field}: ${issue}`;
        if (field) return field;
        if (issue) return issue;
      }
      return String(entry);
    })
    .join('; ');
}

/**
 * Errors raised by this server's own logic (filesystem, planning) rather than by the API.
 * Everything else surfaces as `McpError` so the client shows a protocol error with the message intact.
 */
export class ToolError extends McpError {
  constructor(message: string, reason?: string, hint?: string) {
    super(ErrorCode.InternalError, hint ? `${message}\nHint: ${hint}` : message, { reason: reason ?? null });
    this.name = 'ToolError';
  }
}

export function fromApiError(error: ApiErrorBody, ctx: ErrorContext = {}): McpError {
  const code = error.code;
  const isAuth = code === 'invalid_api_key' || code === 'insufficient_scope' || code === 'unauthorized';
  const protocolCode = isAuth ? ErrorCode.InvalidRequest : code === 'internal_error' ? ErrorCode.InternalError : ErrorCode.InvalidRequest;
  return new McpError(protocolCode, messageFor(code, error.message, { ...ctx, requestId: ctx.requestId ?? error.requestId, details: ctx.details ?? error.details }), {
    code,
    requestId: ctx.requestId ?? error.requestId ?? null,
    details: ctx.details ?? error.details ?? [],
  });
}
