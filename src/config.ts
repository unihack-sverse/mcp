import { resolve } from 'node:path';

/** Mirrors `backend-v2/src/middleware/api-key-auth.js` — the server rejects anything else with `invalid_api_key`. */
export const API_KEY_SHAPE = /^sk_(live|test)_[0-9A-Za-z]{32}$/;

export const DEFAULT_API_URL = 'http://127.0.0.1:4000';

export const DEFAULT_CONSOLE_URL = 'http://localhost:3000';

export const KEY_CREATION_PATH = '/studio/settings?tab=keys';

export interface Config {
  /** Base URL without a trailing slash, e.g. `http://127.0.0.1:4000`. */
  apiUrl: string;
  /** Plaintext API key. Never logged. */
  apiKey: string;
  /** Default project root for filesystem tools. */
  projectDir: string;
  /** Web console base URL used in human-facing instructions. */
  consoleUrl: string;
  /** Overrides the `SVERSE_API_URL` fallback for the console when it is not configured. */
  requestTimeoutMs: number;
}

/** Thrown at startup; the entry point prints `message` to stderr and exits non-zero. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Reads and validates configuration. Call once at startup: every failure here is something the
 * operator must fix in the MCP client config, so the messages point at the fix rather than the symptom.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = (env.SVERSE_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new ConfigError(
      [
        'SVERSE_API_KEY is not set.',
        `Create a key with the "publish" scope at <console>${KEY_CREATION_PATH} (the secret is shown once),`,
        'then add it to the MCP server env block as SVERSE_API_KEY.',
      ].join(' '),
    );
  }
  if (!API_KEY_SHAPE.test(apiKey)) {
    throw new ConfigError(
      'SVERSE_API_KEY is malformed. Keys look like sk_live_<32 alphanumerics> or sk_test_<32 alphanumerics>. ' +
        `Copy the secret from <console>${KEY_CREATION_PATH}; it cannot be recovered after creation.`,
    );
  }

  const rawApiUrl = (env.SVERSE_API_URL ?? '').trim() || DEFAULT_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(rawApiUrl);
  } catch {
    throw new ConfigError(`SVERSE_API_URL is not a valid URL: ${JSON.stringify(rawApiUrl)}. Example: ${DEFAULT_API_URL}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`SVERSE_API_URL must be http(s), got ${parsed.protocol}`);
  }

  const rawConsoleUrl = (env.SVERSE_CONSOLE_URL ?? '').trim() || DEFAULT_CONSOLE_URL;

  const timeout = Number(env.SVERSE_TIMEOUT_MS ?? '');
  const requestTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 20_000;

  return {
    apiUrl: trimSlash(parsed.toString()),
    apiKey,
    projectDir: resolve((env.SVERSE_PROJECT_DIR ?? '').trim() || process.cwd()),
    consoleUrl: trimSlash(rawConsoleUrl),
    requestTimeoutMs,
  };
}

/** Startup banner text. Contains no secret material. */
export function describeConfig(config: Config): string {
  return `sverse-mcp ready: api=${config.apiUrl} project=${config.projectDir} console=${config.consoleUrl}`;
}
