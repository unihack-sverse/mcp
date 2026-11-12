# Sverse MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude Desktop, Claude Code, or Cursor drive a Sverse
game through the publish pipeline: scan the local project, propose a catalogue, run the steps, and submit for
review.

It talks only to the documented `/sdk/v1` API with an API key. It holds no secrets of its own, calls no LLM, and
writes nothing into your project.

**Two guides, one per reader:**

- [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) — for the creator: setup, what each step does, what to do when
  something stops the flow.
- [`docs/AGENT-GUIDE.md`](docs/AGENT-GUIDE.md) — for the assistant: tool contracts, call order, error codes, and
  the rules it must not break.

This README is the short overview; it is deliberately not the reference.

## What it actually does

| Tool | Backs onto | Reads real data? |
|---|---|---|
| `sverse_whoami` | `GET /sdk/v1/me` | Yes — studio, bound game, scopes |
| `sverse_scan_project` | local filesystem + `POST …/steps/scan_project` | **Yes** — engine from descriptor files, scenes from scene files, surfaces from file names |
| `sverse_propose_items` | `GET /schemas` + `POST …/steps/propose_items` | Yes for schemas; prices come from fixed bands, not from your game |
| `sverse_run_step` | `POST …/steps/:step` | Yes — one state-machine step |
| `sverse_get_job` | `GET …/publish/jobs/:id` | Yes — and tells you what to do next |
| `sverse_publish` | `POST …/steps/publish` | Yes — submits for review |
| `sverse_preview_sdk` | pure local | Yes — the project files it would touch |

Honest about the guessing:

- **Scene counts** are real file counts (`.unity`, `.tscn`, `.umap`, `.scene`) but "scene" here means a scene
  file, not a loaded level.
- **Monetisation surfaces** are inferred from asset *names* matching `shop|store|cosmetic|skin|bundle|pass|
  battle_pass|chest|loot|coin|gem|currency|outfit|starter`. A game whose shop is called `CrimsonBazaar` will be
  missed. When nothing matches, the tool says so instead of inventing a number.
- **Prices** come from fixed bands (Starter Pack 120 SRV, Season Pass 240 SRV, cosmetics 60–95 SRV, consumable
  15 SRV), in integer micro-SRV. Adjust them in the console before approval if they are wrong for your game.
- **Engine version** for Godot is the major only (`"4"`): `project.godot` records `config_version`, not a patch
  version.

### Why seven tools, not the nine in the concept

`concept/sverse-concept.md` describes nine. `create_studio` is dropped — you already have a studio by the time you
hold an API key, and studio creation stays a console action. `create_item_pack` is not a separate tool because it
is one guarded step of `sverse_run_step`. `emit_deed` belongs to the game's runtime SDK, not to publishing.

## Why the approval step is not in MCP

Proposed items cannot be written until a **human** approves the catalogue. That is enforced by the API, not by
this server: `/sdk/v1/publish/jobs/:id/approve-catalog` returns `403 human_approval_required` for any API key
(`backend-v2/src/modules/sdk/routes.js:175`, `publish.service.js:100-101`), per UC-19 §5.

So the flow is:

1. The model proposes a catalogue.
2. `sverse_run_step` with `create_item_pack` returns **instructions and makes no API call**.
3. You open `http://localhost:3000/studio/publish?job=<id>` and approve.
4. `sverse_get_job` re-reads the job and shows approval landed; the model continues.

An assistant that tries to skip step 3 will be told exactly what to ask you to do. It cannot approve on your
behalf, and neither can a compromised key.

## Setup

### 1. Create an API key

Open `<console>/studio/settings?tab=keys` and create a key with the scopes **`publish`** and **`read`**.

- `publish` is required for every publish call.
- `read` is required for `GET /schemas`, which `sverse_propose_items` needs to map items to trait schemas. A
  `publish`-only key works for everything except proposing items.

The secret is shown **once**. It looks like `sk_live_` + 32 alphanumerics and cannot be recovered.

Optionally bind the key to one game. A game-bound key can only touch that game's jobs (`not_your_job`
otherwise), which is the safer choice for an assistant.

### 2. Build the server

```bash
cd mcp
npm install
npm run build          # produces dist/index.js
```

`@modelcontextprotocol/sdk` is pinned to an exact version in `package.json`. Do not float it: the tool
registration API has changed across releases, and a floating install can produce a server that starts but
registers no tools.

### 3. Point your client at it

Use the absolute path to `mcp/dist/index.js`.

**Claude Desktop** — `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "sverse": {
      "command": "node",
      "args": ["D:\\sverse\\mcp\\dist\\index.js"],
      "env": {
        "SVERSE_API_KEY": "sk_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        "SVERSE_API_URL": "http://127.0.0.1:4000",
        "SVERSE_PROJECT_DIR": "D:\\sverse\\my-game"
      }
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json` uses the same shape:

```json
{
  "mcpServers": {
    "sverse": {
      "command": "node",
      "args": ["D:\\sverse\\mcp\\dist\\index.js"],
      "env": {
        "SVERSE_API_KEY": "sk_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        "SVERSE_API_URL": "http://127.0.0.1:4000",
        "SVERSE_PROJECT_DIR": "D:\\sverse\\my-game"
      }
    }
  }
}
```

### 4. Environment

| Variable | Default | Meaning |
|---|---|---|
| `SVERSE_API_KEY` | — (required) | Key with `publish` (and ideally `read`) scope |
| `SVERSE_API_URL` | `http://127.0.0.1:4000` | API base URL |
| `SVERSE_PROJECT_DIR` | server working directory | Default project to scan |
| `SVERSE_CONSOLE_URL` | `http://localhost:3000` | Console base URL used in approval instructions |
| `SVERSE_TIMEOUT_MS` | `20000` | Per-request timeout |

Use the same host form for the API and the console. Session cookies have no `domain` attribute, so mixing
`localhost` and `127.0.0.1` makes the console look logged out even when the API is fine.

## Driving the flow

The same order the state machine enforces. A step cannot run until every earlier step is done, and **re-running a
step clears every later step and the catalogue approval** — only retry to recover from a failure.

```text
sverse_whoami                 → which studio/game this key can touch
sverse_scan_project           → creates (or reuses) a job and records the scan
sverse_propose_items          → proposes a catalogue, cites the files behind each item
sverse_run_step map_to_schema → maps each item to a trait schema
  ↓ human approves in the console
sverse_run_step create_item_pack
sverse_run_step install_sdk   → records the integration (use sverse_preview_sdk for the actual code)
sverse_run_step test_purchase → sandbox purchase + refund
sverse_publish                → submits for review
```

`sverse_get_job` at any point returns `nextAction`: `run:<step>`, `approve-in-console`, `done`, or `blocked`.

## Debugging

Run with the Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Logs go to **stderr** only — stdout is the JSON-RPC channel, and a stray `console.log` would corrupt the stream.

Common failures:

| Symptom | Cause |
|---|---|
| Server exits immediately | `SVERSE_API_KEY` missing or malformed; the message says where to create one |
| `invalid_api_key` | Key revoked or mistyped; the plaintext cannot be recovered |
| `insufficient_scope` | Key lacks `publish`, or lacks `read` for `sverse_propose_items` |
| `not_your_job` | The key is bound to a different game than the job's |
| `Could not reach the Sverse API` | Backend is not running at `SVERSE_API_URL` |
| `step_out_of_order` | An earlier step is not done; the message names it |

## Development

```bash
npm run check          # tsc --noEmit
npm test               # heuristic regression tests (no backend needed)
npm run build
npm run smoke          # end-to-end against a local backend (needs SVERSE_API_KEY)
node scripts/protocol-check.mjs   # MCP handshake against dist/index.js
```

The smoke test needs a seeded backend (`backend-v2 && npm run seed:reset && npm run dev`). It stops at the
approval gate, proves an API key cannot approve, then — unless `SVERSE_SMOKE_HUMAN=1` — approves out of band so the
rest of the pipeline runs. With `SVERSE_SMOKE_HUMAN=1` it waits up to 5 minutes for you to approve in the console.

Test-only helpers: `backend-v2/scripts/mint-mcp-key.mjs <scopes> [gamePid]` mints a key directly in the database
(the console is the supported path for creators).

## Scope of this build

- stdio transport only; no hosted/SSE endpoint
- no LLM inside `propose_items` — heuristics only, deterministic and explainable
- `install_sdk` never writes files; `sverse_preview_sdk` returns a diff for you to apply
- not published to npm; point clients at the local `dist/index.js`
- requires an existing studio, game, and API key — `create_studio` is out of scope
