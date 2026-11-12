# Sverse MCP — user guide

Publish a game to the Sverse store from Claude, Cursor, or ChatGPT on your own machine. The assistant scans
your project, proposes what to sell, and walks the pipeline — but **you** approve the catalogue. Nothing goes
on sale without that click.

The technical reference for the assistant is `docs/AGENT-GUIDE.md`. This file is the human version.

## What it will and will not do

| It does | It does not |
|---|---|
| Read your project folder to detect the engine and count scenes | Upload, zip, or host your build |
| Propose a catalogue with prices, and say which file justified each item | Invent numbers when it cannot count something |
| Run the publish steps against the Sverse API | Write files into your project |
| Show you the SDK diff so you can apply it | Install the SDK for you |
| Submit the game for review | Approve the catalogue (only you can) |

Prices it proposes are defaults from fixed bands, not from your game. Change them in the console before
approving.

## 1. Get an API key

Open `http://localhost:3000/studio/settings?tab=keys` and create a key with **both** scopes:

- `publish` — required for every publish action.
- `read` — required to fetch trait schemas; without it, proposing items fails.

The secret looks like `sk_live_` followed by 32 characters. **It is shown once.** If you lose it, create a new
key — the old one cannot be recovered.

**Bind the key to one game** if you are handing it to an assistant. A bound key can only touch that game, so a
mistake cannot publish the wrong thing.

## 2. Build the server

```bash
cd mcp
npm install
npm run build
```

This produces `dist/index.js`. Point your client at that file by absolute path.

## 3. Configure your client

### Cursor — `C:\Users\<you>\.cursor\mcp.json`

```json
{
  "mcpServers": {
    "sverse": {
      "command": "node",
      "args": ["D:\\sverse\\mcp\\dist\\index.js"],
      "env": {
        "SVERSE_API_KEY": "sk_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        "SVERSE_API_URL": "http://127.0.0.1:4000",
        "SVERSE_PROJECT_DIR": "D:\\path\\to\\your\\game"
      }
    }
  }
}
```

### Claude Desktop — `%APPDATA%\Claude\claude_desktop_config.json`

Same shape, same keys.

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `SVERSE_API_KEY` | — (required) | Your key, with `publish` and `read` |
| `SVERSE_API_URL` | `http://127.0.0.1:4000` | Where the API runs |
| `SVERSE_PROJECT_DIR` | server working directory | Default folder to scan |
| `SVERSE_CONSOLE_URL` | `http://localhost:3000` | Used to build the approval link |
| `SVERSE_TIMEOUT_MS` | `20000` | Per-request timeout |

Use the **same host form** everywhere. Session cookies have no `domain`, so mixing `localhost` and `127.0.0.1`
makes the console look logged out while the API is fine.

## 4. Run it

Tell the assistant to publish, or paste this:

```
Use the sverse tools to publish my game.
Start with sverse_whoami so we know which studio and game the key is bound to.
Then scan, propose items, and run map_to_schema.
Stop when the job needs approval and give me the console link.
```

It will stop and hand you something like:

> The catalogue needs your approval. Open
> `http://localhost:3000/studio/publish?job=job_abc123` and approve it.

**Open that link.** Check the item names, kinds, and prices — they came from heuristics, not from your game.
Edit anything wrong, then press **Approve catalog**. Go back to the assistant and say "approved".

It continues on its own from there.

## What the steps mean

| Step | What happens |
|---|---|
| Scan the project | Detects engine from descriptor files, counts scene files and likely shop surfaces |
| Propose items | Builds a catalogue; always a Starter Pack and Season Pass, plus cosmetics per slot found |
| Match shared schemas | Assigns each item a standard schema, then a tier the schema actually allows (cosmetic → T1, living → T2; a bundle can stay T0 if its schema caps there) |
| **Your approval** | Nothing is written until you click |
| Create the items | Writes the item definitions to your game |
| Install the SDK | Records that you integrated it — **writes no files** |
| Test a purchase | Runs a sandbox purchase and refunds it |
| Submit for review | Runs automated checks; game goes live if the listing bond is staked |

## Things that can stop you

| Message | Fix |
|---|---|
| `build_required` | Add a build URL in `/studio/games/<id>` → Details → Basics |
| `catalog_required` | The game needs at least one active item |
| `bond_required` | Stake SRV in `/studio/payouts` |
| `email_unverified` | Verify your email |
| `insufficient_scope` | New key with `publish` **and** `read` |
| `not_your_job` | Your key is bound to a different game |
| `invalid_api_key` | Key was revoked or mistyped — create a new one |
| Cannot reach the API | Check the backend is running on `SVERSE_API_URL` |

## Re-running a step

You probably should not. Re-running any step **clears every later step and the catalogue approval**. It is
only for recovering from a failure. If a run is stuck, start a new run instead of retrying.

## Being honest about the guessing

The scanner reads real files, but three things are inferred and you should know it:

- **Scenes** counts scene files, not loaded levels.
- **Shop surfaces** are guessed from asset names like `shop`, `skin`, `battle_pass`. If your shop is called
  `CrimsonBazaar`, it will not be detected, and the tool will say so rather than guess a number.
- **Prices** come from bands: Starter Pack 120 SRV, Season Pass 240 SRV, cosmetics 60–95 SRV, consumable
  15 SRV. They are a starting point, not a valuation.

## Debugging

```bash
cd mcp
npx @modelcontextprotocol/inspector node dist/index.js
```

Logs go to stderr only — stdout is the protocol channel.

Self-checks, no backend needed:

```bash
npm test                 # heuristic regression tests
node scripts/protocol-check.mjs   # real MCP handshake, lists the seven tools
```

End-to-end against a local backend:

```bash
cd backend-v2 && npm run seed:reset && npm run dev
node scripts/mint-mcp-key.mjs publish,read          # prints a test key
cd ../mcp && set SVERSE_API_KEY=sk_live_... && npm run smoke
```
