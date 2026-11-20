# Sverse MCP — agent guide

Read this before calling any `sverse_*` tool. It is written for an assistant driving the server, not for a
human. The human-facing version is `docs/USER-GUIDE.md`.

## What this server is

An MCP server over stdio that exposes Sverse publishing as seven tools. It authenticates with a single API key
from the environment. It holds no LLM, keeps no state between calls, and never writes to the project directory.

Everything it returns is either (a) real data from the Sverse API, (b) real data read from local files, or
(c) an explicit statement that a value could not be determined. **There are no invented numbers.** If a field
is absent from the output, do not fill it in.

## The one rule that matters

**You cannot approve the catalogue.** `create_item_pack` is refused for API keys by the server
(`403 human_approval_required`). The tool intercepts this, makes no API call, and returns instructions.
When you see that response, stop and ask the human to approve in the console. Do not retry the step, do not
look for a workaround, and do not tell the user it failed — it did not run.

## Call order

The publish pipeline is a strict state machine. A step cannot run until every earlier step is `done`, and
**re-running any step clears every later step plus the approval**. Never re-run a step to "refresh" it.

```
sverse_whoami                  → validate the key, learn the studio and (possibly) the bound game
sverse_scan_project            → create the job, record the scan
sverse_propose_items           → fill the draft catalogue
sverse_run_step map_to_schema  → assign trait schemas and interop tiers
   ── HUMAN APPROVES IN CONSOLE ──
sverse_run_step create_item_pack
sverse_run_step install_sdk
sverse_run_step test_purchase
sverse_publish
```

`sverse_get_job` is safe to call at any point and tells you what is due. Call it instead of guessing.

## Tools

### `sverse_whoami`

No input. Returns the studio, the game the key is bound to (`null` if unbound), the scopes, and `canPublish`.

Call this first, always. It is the only way to know whether the key is bound to one game — a bound key will
reject jobs for other games with `not_your_job`, and a key without `publish` will fail at the end of the flow
after the human already did the approval work.

### `sverse_scan_project`

Inputs: `path?`, `gameId?`, `title?`, `genre?`, `engine?`.

Scans the local directory, detects the engine from descriptor files, counts scene files and monetisation
surfaces from asset names, creates a publish job, and records the scan.

Target game resolution, in order:
1. `gameId` if passed.
2. `title` if passed — creates a new game.
3. The game bound to the API key.
4. Otherwise the call fails with an explanatory message.

Honesty notes you must relay rather than smooth over:
- `scenes` counts scene **files** (`.tscn`, `.unity`, `.umap`, `.scene`), not loaded levels.
- `surfaces` are inferred from asset names matching `shop|store|cosmetic|skin|bundle|pass|battle_pass|chest|loot|coin|gem|currency|outfit|starter`. A shop called `CrimsonBazaar` will not match.
- `engineVersion` for Godot is the major only, because `project.godot` stores `config_version`.
- If nothing matched, the field is absent — say so. Do not estimate.

### `sverse_propose_items`

Inputs: `jobId`, `path?`, `limit?`.

Derives a catalogue from the recorded scan. Deterministic: the same project always produces the same draft.
Every item carries `rationale` naming the file that justified it — quote that when explaining the proposal.

Baseline rules: always a Starter Pack (120 SRV) and a Season Pass (240 SRV); one cosmetic per slot found
(60–95 SRV); a consumable (15 SRV) when a loot/chest surface exists.

Prices are integer micro-SRV strings where `1 SRV = 1_000_000`. Never present them as floats.

This does not write items. It records a draft that needs approval.

### `sverse_run_step`

Inputs: `jobId`, `step`, `input?`.

Runs exactly one step. Per-step inputs:

| step | input |
|---|---|
| `scan_project` | `{ engine?, engineVersion?, scenes?, surfaces?, monetizableObjects? }` — prefer `sverse_scan_project` |
| `propose_items` | `{ draft: [...] }` — prefer `sverse_propose_items` |
| `map_to_schema` | `{ overrides?: { [sku]: schemaId } }` |
| `create_item_pack` | `{}` — **refused until human approval** |
| `install_sdk` | `{ sdk, version, filesChanged? }` |
| `test_purchase` | `{}` |
| `publish` | `{}` — prefer `sverse_publish` |

### `sverse_get_job`

Input: `jobId`. Returns the job plus `nextAction.kind`:

- `run` — with the step name and the tool to call.
- `approve-in-console` — stop and ask the human. Include the URL from the response.
- `done` — finished.
- `blocked` — with the reason and what the human must fix.

Always read fresh. Calling it after the human says "approved" is correct and expected.

### `sverse_publish`

Input: `jobId`. Terminal and irreversible: submits the game for review and runs the automated checks.

The tool refuses locally when the job is already `done`, has no publish step, has an earlier step that is not
`done`/`skipped`, or has no catalogue approval (`approve-in-console` still pending).

The server re-checks more and can still refuse after that local gate passes: a missing build URL
(`build_required`), no active item (`catalog_required`), an unverified email (`email_unverified`), or a listing
bond below minimum (`bond_required`). Those arrive as the API's error message — relay the advice verbatim,
because each names an action only the human can take. Do not retry until it is fixed.

### `sverse_preview_sdk`

Inputs: `path?`, `sdk?`, `engine?`, `version?`. Read-only.

Returns a unified diff, the file list, and manual steps the CLI cannot perform. **It writes nothing.**
`install_sdk` also writes nothing — it only records metadata. If the human wants the SDK installed, they apply
the diff themselves.

## Error handling

Every error carries a code. Translate it for the human; do not paste raw JSON.

| Code | Meaning | What to tell the human |
|---|---|---|
| `invalid_api_key` | Key revoked or mistyped | Create a new key in the console; the plaintext is unrecoverable |
| `insufficient_scope` | Missing `publish` (or `read` for schemas) | Re-create the key with both scopes |
| `not_your_job` | Key bound to a different game | Use the bound game, or mint an unbound key |
| `step_out_of_order` | An earlier step is not done | The message names it — run that first |
| `human_approval_required` | API key tried to approve | The human must approve in the console |
| `build_required` | Game has no build URL | Add one in `/studio/games/<id>` → Details → Basics |
| `catalog_required` | No active item on the game | Add at least one item, or publish one through the flow |
| `bond_required` | Listing bond below minimum | Stake in `/studio/payouts` |
| `email_unverified` | Creator email not verified | Verify the email |
| Network error | Backend unreachable | Check `SVERSE_API_URL` and that the API is running |

## Things you must not do

- Do not claim a step succeeded without a tool result saying so.
- Do not invent scene counts, prices, or engine versions.
- Do not convert micro-SRV to floats.
- Do not retry `create_item_pack` hoping the approval gate opens.
- Do not re-run a completed step to "refresh" the job — it clears later work.
- Do not tell the human the SDK was installed; it was only recorded.
- Do not call `sverse_publish` before `sverse_get_job` says the publish step is the next action.

## A correct session, start to finish

```
1. sverse_whoami
   → studio kai.solo, game "22" (draft), scopes game+read+publish, canPublish true
   → tell the human: bound to "22", can publish

2. sverse_scan_project { path: "D:\\game" }
   → job_abc123, engine godot 4, 3 scenes, 2 surfaces, signals: shop, battle_pass

3. sverse_propose_items { jobId: "job_abc123" }
   → 4 items with rationale; mention that prices are defaults from bands

4. sverse_run_step { jobId, step: "map_to_schema" }
   → cosmetic → T1, bundle → T2, pass → unmapped

5. sverse_get_job { jobId }
   → nextAction.kind = "approve-in-console"
   → STOP. Print the URL. Ask the human to approve. Do not continue.

6. (human says "approved")

7. sverse_run_step { jobId, step: "create_item_pack" }
8. sverse_preview_sdk { path }   → show the diff, let the human decide
9. sverse_run_step { jobId, step: "install_sdk", input: { sdk: "sverse-godot", version: "0.1.0" } }
10. sverse_run_step { jobId, step: "test_purchase" }
11. sverse_publish { jobId }
12. sverse_get_job { jobId }      → status, game status
```
