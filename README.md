# survey-creator-collaboration-v2

Collaborative (multi-user) editing for SurveyJS Creator, built on the **journal plugin**
(`CollaborationPlugin` from `survey-creator-core`): every local edit becomes a small JSON
*record*; peers apply the record stream and converge (last write wins, no CRDT/OT).

Four client apps share one framework-agnostic collab module and one relay server:

| URL | App |
|---|---|
| `/` | Lobby — pick a framework, enter/create a room |
| `/react/?room=<id>` | React 18 + `survey-creator-react` |
| `/angular/?room=<id>` | Angular 18 + `survey-creator-angular` |
| `/vue/?room=<id>` | Vue 3 + `survey-creator-vue` |
| `/js/?room=<id>` | Plain JS + `survey-creator-js` |

## Architecture

```
Creator edit ─► CollaborationPlugin.onRecordAdded/Changed ─► {type:"append", payload} ─► server
server: room.log.push(payload) ─► broadcast {type:"record", from, payload} to other clients
receiver: plugin.apply(payload)          (echo-suppressed, idempotent)
late joiner: {type:"init", seed, log} ─► creator.JSON = seed; plugin.apply(log)

focus change ─► CollaborationPlugin.onStateChanged ─► {type:"presence", state} ─► server
server: wrap {clientId, name, color, state} ─► broadcast {type:"presence", peer} to others
receiver: presence.upsertPeer(peer)      (the plugin renders the overlay itself)
```

- **`PROTOCOL.md`** — the language-agnostic protocol specification. The Node server in
  [`server/`](server/) is a *reference implementation*: records and survey JSON are opaque
  to it, it has **no SurveyJS dependency**, and it is intentionally trivial to port to
  Go/.NET/Java/Python (room = `{seed, log[], clients}`, four operations, in-memory + TTL GC).
- **`shared/collab-client.ts`** — the one collab module all four clients use. It has zero
  imports (structural typing + injection) so each differently-bundled app compiles it
  against its *own* copy of `survey-creator-core`.
- **`lobby/`** — a small React app whose form is *itself a SurveyJS survey* rendered
  with `survey-react-ui`. Empty room id → random room with an empty survey; a new room
  id → textarea for the initial survey JSON (the seed); an existing room id → join.
  Invite links (`/?room=<id>`) prefill the room field.
- **`clients/*`** — four independent apps (each with its own `package.json`/lockfile; no
  npm workspaces on purpose). Survey packages come from the sibling local builds via
  `file:` deps (`../survey-library/...`, `../survey-creator/...`).

## Run

Node **20.11+** required (Angular 18). From a bare checkout:

```bash
npm install    # server deps, then bootstrap: clone/build the sibling survey repos
               # and install lobby + the 4 clients (first run ~20-40 min, a few GB)
npm start      # builds lobby + all 4 clients, then serves everything on :8080
```

`npm install` runs [`scripts/bootstrap.mjs`](scripts/bootstrap.mjs) as `postinstall`. It is idempotent —
every step is skipped when its output is already there, so a second `npm install` costs seconds.

| Variable | Effect |
|---|---|
| `COLLAB_SKIP_BOOTSTRAP=1` | do nothing (CI, or `npm install <pkg>`) |
| `COLLAB_FORCE_REBUILD=1` | ignore all skips and rebuild every survey package |

What bootstrap does, and why it is needed at all: this app cannot take the survey packages from
npm — the published `survey-creator-core` has no `CollaborationPlugin`, and the `file:`
deps of `lobby/` + `clients/*` point at sibling **`build/` output** dirs, which are gitignored in
both sibling repos. So it:

1. clones the siblings next to this checkout if they are missing (an existing checkout is reused
   as is and never fetched/checked out over):
   - `../survey-library` — branch `V3`
   - `../survey-creator` — branch `feature/journal-plugin` (this is where the plugins live)
2. builds all 10 packages in dependency order — `survey-core` → `survey-{react,vue3,js,angular}-ui`
   → `survey-creator-core` → `survey-creator-{react,vue,js,angular}` — producing
   `../survey-{library,creator}/packages/*/build` at matching versions (currently `3.0.0-beta.8`);
3. installs `lobby` + the four `clients/*` (same work as `npm run install:clients`, with skips).

The presence plugin owns both sides of presence: capturing the local state (tab, selection,
property-grid focus, cursor) and rendering remote peers; `collab-client.ts` only ships the opaque
state and feeds server-stamped `{clientId, name, color, state}` envelopes back into it.

Open http://localhost:8080, create a room, open the same room in another tab/browser
(any framework) — edits sync live.

Dev loop for one client (Vite/ng dev server with /api and /ws proxy to :8080):

```bash
npm run server            # terminal 1: relay + lobby + built clients
npm run dev:react         # terminal 2: lobby | react | vue | js | angular
```

## Tests

```bash
npx playwright install chromium   # once
npm run build:clients             # e2e runs against the built bundles
npm run test:e2e
```

The suite covers the lobby flows (random room, seed form, invalid JSON, existing room),
two-tab live sync for each of the four frameworks, one room open in all four frameworks
at once, late-joiner bootstrap (seed + log replay), room isolation, and WS auto-creation.

Protocol-level unit coverage lives with the plugin itself
(`../survey-creator/packages/survey-creator-core/tests/journal*.tests.ts`).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP/WS port |
| `HOST` | `localhost` | Bind address |
| `EMPTY_ROOM_TTL_MS` | `1800000` (30 min) | How long an empty room lives before GC |
| `SURVEYJS_LICENSE_KEY` | — | SurveyJS Creator license key, baked into the client bundles **at build time** (`npm run build:clients` / `npm start`). Set it either in a `.env` file at the repo root (copy `.env.example`; gitignored) or via docker compose `environment:` — a real environment variable wins over `.env`. Vite clients read `.env` through `envDir`/`envPrefix`, the Angular client through `scripts/gen-license-key.mjs` (npm pre-hook). |

## Notes & caveats

- The server appends *every* incoming record, including coalesced re-sends of the same
  logical record (rapid typing); replaying the log in order converges because the applier
  is last-write-wins. Do not deduplicate by `payload.seq` — it is per-client.
- Room state is memory-only by design; a server restart loses rooms (see `PROTOCOL.md`
  for what a persistent port would need to keep).
- The Angular build needs `preserveSymlinks: true` (set in `angular.json`): the survey
  `file:` deps are symlinks into repos that carry their own old `@angular/*` copies, and
  resolving through real paths would bundle two Angular runtimes.
