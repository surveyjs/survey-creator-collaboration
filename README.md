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
  npm workspaces on purpose). The survey packages come from npm (`^3.0.1`) — including
  `CollaborationPlugin`, which ships in `survey-creator-core/collaboration`.

The presence plugin owns both sides of presence: capturing the local state (tab, selection,
property-grid focus, cursor) and rendering remote peers; `collab-client.ts` only ships the opaque
state and feeds server-stamped `{clientId, name, color, state}` envelopes back into it.

## Run

Node **20.11+** required (Angular 18). From a bare checkout:

```bash
npm install    # server deps, then lobby + the four clients (postinstall)
npm start      # builds lobby + all 4 clients, then serves everything on :8080
```

`npm install` runs `install:clients` as `postinstall`, so a fresh clone needs nothing else
— every survey package, `CollaborationPlugin` included, comes from npm.

Open http://localhost:8080, create a room, open the same room in another tab/browser
(any framework) — edits sync live.

Dev loop for one client (Vite/ng dev server with /api and /ws proxy to :8080):

```bash
npm run server            # terminal 1: relay + lobby + built clients
npm run dev:react         # terminal 2: lobby | react | vue | js | angular
```

## Developing against local survey builds

To work on the collaboration plugin itself, every app has a `:local` variant that resolves
`survey-*` to the sibling `../survey-library` and `../survey-creator` **`build/`** dirs
instead of the npm copies:

```bash
npm run dev:react:local     # or build:react:local, build:clients:local
npm run dev:react:watch     # same, plus `watch:dev` in the survey packages via concurrently
npm run typecheck:local     # inside an app: typecheck against the local .d.ts
```

Build the packages in the sibling checkouts first (`npm run build:all` for `survey-core`
and `survey-creator-core`, `npm run build` for the rest). All ten must be built **at the
same version** — a mismatched or partial set throws with the list of offenders rather than
silently mixing local and npm copies of the same library. Set `SURVEYJS_LIBV3` in the root
`.env` if the checkouts do not live next to this repo.

The aliases are derived from each package's `exports` map
([`scripts/local-survey-alias.mjs`](scripts/local-survey-alias.mjs)) rather than pointing at
the `build/` dir as a whole: a plain directory alias bypasses `exports`, so subpaths like
`survey-core/themes` and `survey-creator-core/collaboration` would land on the CJS bundles,
which pull in a second copy of the library (two `Serializer` singletons). The sibling repo
`theme-adapter-demos` uses the same alias approach for the same reason, and can get away
with plain directory aliases only because it imports no JS subpaths.

The Angular client goes through `--configuration local` and
[`clients/angular/tsconfig.local.json`](clients/angular/tsconfig.local.json) instead — the
esbuild builder honours tsconfig `paths` for both type checking and bundling. Static paths
cannot run the check above, so an npm pre-hook
([`scripts/check-local-survey.mjs`](scripts/check-local-survey.mjs)) does it instead; the
same hook guards `typecheck:local`. That table is hand-kept, so a newly imported subpath
falls back to the npm copy until it is added. To confirm which copy you actually got, check
the version marker in the bundle:

```bash
grep -ohE '"3\.[0-9]+\.[0-9]+"' clients/react/dist/assets/*.js | sort -u
```

`survey-angular-ui` and `survey-creator-angular` ship no watch script (ng-packagr), so
`dev:angular:watch` only watches `survey-core` and `survey-creator-core`; rebuild those two
by hand after editing them.

## Tests

```bash
npx playwright install chromium   # once
npm run build:clients             # e2e runs against the built bundles
npm run test:e2e
```

The suite covers the lobby flows (random room, seed form, invalid JSON, existing room),
two-tab live sync for each of the four frameworks, one room open in all four frameworks
at once, late-joiner bootstrap (seed + log replay), room isolation, and WS auto-creation.

Protocol-level unit coverage lives with the plugin itself, upstream in the
`survey-creator` repo (`packages/survey-creator-core/tests/journal*.tests.ts`) — a local
checkout of it is not part of this project's setup.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP/WS port |
| `HOST` | `localhost` | Bind address |
| `EMPTY_ROOM_TTL_MS` | `1800000` (30 min) | How long an empty room lives before GC |
| `SURVEYJS_LICENSE_KEY` | — | SurveyJS Creator license key, baked into the client bundles **at build time** (`npm run build:clients` / `npm start`). Set it either in a `.env` file at the repo root (copy `.env.example`; gitignored) or via docker compose `environment:` — a real environment variable wins over `.env`. Vite clients read `.env` through `envDir`/`envPrefix`, the Angular client through `scripts/gen-license-key.mjs` (npm pre-hook). |
| `SURVEYJS_LIBV3` | — | Only for the `:local` scripts: where the `survey-library` and `survey-creator` checkouts live, if not right next to this repo. Absolute, or relative to the repo root. Same variable as in `theme-adapter-demos`. Has no effect on the Angular client, whose `tsconfig.local.json` paths are static. |

## Notes & caveats

- The server appends *every* incoming record, including coalesced re-sends of the same
  logical record (rapid typing); replaying the log in order converges because the applier
  is last-write-wins. Do not deduplicate by `payload.seq` — it is per-client.
- Room state is memory-only by design; a server restart loses rooms (see `PROTOCOL.md`
  for what a persistent port would need to keep).
- `resolve.dedupe` in the Vite configs is load-bearing, not cosmetic: survey-core's
  `Serializer` is a singleton, and in `:local` mode the aliased sibling builds sit next to
  their own React 17 / Vue copies that would otherwise be pulled in alongside the app's.
- The clients enable `showJSONEditorTab`, but `ace-builds` (an optional peer of
  `survey-creator-core`) is not installed, so the JSON tab uses the plain textarea editor.
