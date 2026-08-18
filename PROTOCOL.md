# Collaboration Server Protocol

A language-agnostic specification of the server side of collaborative Survey Creator
editing. The Node.js server in [`server/`](server/) is a *reference implementation*;
the protocol is designed so that a production server can be written in any
language/framework (Go, .NET, Java, Python, ...) without depending on any SurveyJS
package.

## Core idea

Clients run the SurveyJS Creator with the **journal plugin**, which turns every local
edit into a small JSON value called a *record*. The server never inspects records — it
treats them as **opaque JSON** ("store and forward as is"). All convergence logic lives
in the clients: applying an ordered stream of records is idempotent and last-write-wins,
so every client that receives the same seed and the same record sequence ends up with
the same survey.

The server's entire job:

1. Keep a set of **rooms**. A room is: `{ id, seed, log, clients }`
   - `seed` — the initial survey JSON (opaque), set at room creation.
   - `log` — an append-only array of records (opaque JSON values) in **arrival order**.
   - `clients` — the currently connected WebSocket clients, each with a server-assigned id.
2. When a client connects: send it `seed` + the whole `log` (the `init` message).
3. When a client sends a record: append it to `log` and broadcast it to **every other**
   client in the room (never echo it back to the sender).
4. Garbage-collect rooms that stay empty longer than a TTL.

That is all. No locks, no diffing, no record inspection, no persistence required
(in-memory storage is acceptable; persistence is an implementation choice).

## Identifiers

- **Room id**: chosen by clients. MUST match `^[A-Za-z0-9_-]{1,64}$`. Anything else is
  rejected with HTTP 400 / WS close.
- **Client id**: assigned by the server on each WebSocket connection (any unique string;
  the reference implementation uses a UUID). Sent to the client in `init` and used as
  `from` in relayed messages.

## HTTP API

All responses are JSON, UTF-8. CORS: permissive (`Access-Control-Allow-Origin: *`) —
tighten in production as needed.

### `GET /api/rooms/{roomId}`

Room existence probe (used by the lobby while the user types a room id).

- `200 OK` — room exists:

  ```json
  { "roomId": "demo1", "exists": true, "clientCount": 2, "logLength": 17 }
  ```

- `404 Not Found` — room does not exist:

  ```json
  { "exists": false }
  ```

- `400 Bad Request` — invalid room id.

### `POST /api/rooms`

Create a room with an initial state.

Request body:

```json
{ "roomId": "demo1", "seed": { "pages": [ ... ] } }
```

- `roomId` — required, validated as above.
- `seed` — optional initial survey JSON (opaque to the server). Defaults to `{}`.

Responses:

- `201 Created` — `{ "roomId": "demo1" }`
- `409 Conflict` — room already exists (its seed/log are NOT touched). Clients treat
  this as "someone created it concurrently — just join".
- `400 Bad Request` — invalid id or malformed JSON body.

### `GET /health`

`200 OK` — `{ "ok": true }`. Liveness probe.

## WebSocket: `ws(s)://host/ws/rooms/{roomId}?name={displayName}`

One connection = one participant in one room. If the room does not exist when a client
connects, the server MUST auto-create it with seed `{}` (this keeps pasted deep links
working).

`name` is the participant's display name (part of the presence extension). The server
sanitizes it: trim, cut to 32 characters (`PRESENCE_NAME_MAX`), and substitute `"Guest"`
when missing or empty. The server stamps the name onto every relayed presence envelope,
so it never travels inside the presence state itself.

All messages are single JSON objects (text frames). Unknown message types MUST be
ignored (forward compatibility).

### Server → client: `init` (sent once, immediately after connect)

```json
{
  "type": "init",
  "clientId": "3f2c8b9e-...",
  "color": "#e51a5f",
  "seed": { },
  "log": [ { "v": 1, "seq": 1, "...": "opaque record" }, ... ]
}
```

`color` is part of the optional presence extension (see below); servers that don't
implement presence may omit it, and clients must treat it as optional.

The client bootstraps from it: set the creator's survey to `seed`, then apply every
entry of `log` in array order. The server MUST NOT send any `record` message to a
client before its `init`.

### Client → server: `append`

```json
{ "type": "append", "payload": { "...": "opaque record" } }
```

The server appends `payload` to the room log and broadcasts it to all other clients.
Messages that are not valid JSON, have a different `type`, or lack `payload` are
silently ignored.

Note: clients may re-send an *updated version* of a previously sent record (the journal
plugin coalesces rapid typing into one record and re-emits it). The server does NOT
deduplicate — it appends every `append` as a new log entry. Replaying such a log
converges because the applier is last-write-wins. Consequence: never key or deduplicate
log entries by any field inside `payload` (e.g. `seq` — it is per-client and not unique
across clients).

### Server → other clients: `record`

```json
{ "type": "record", "from": "3f2c8b9e-...", "payload": { "...": "opaque record" } }
```

- `from` — the clientId of the author. Receivers use it defensively to drop their own
  echoes; the server must already exclude the sender from the broadcast.
- Broadcast order SHOULD match log-append order (single-threaded room handling, as in
  the reference implementation, gives this for free).

## Presence (ephemeral extension)

An OPTIONAL extension that lets participants see each other: name, active tab,
selected element, keyboard focus, mouse cursor. Servers and clients
that don't implement it interoperate unchanged — all presence message types fall
under the "unknown types MUST be ignored" rule, and `init.color` is additive.

Principles:

- Presence is **ephemeral**: it NEVER enters the room log. The server stores only
  the **latest** state per connected client and forgets it on disconnect.
- Presence state is **opaque to the server** (like records). The state schema is a
  creator-side convention: it is produced and consumed by survey-creator-core's
  `CollaborationPlugin` (`IPresenceState`) — pure focus data (tab, selection, keyboard
  focus, cursor), with no user identity inside.
- **User identity lives in the envelope, not the state**: the server stamps
  `clientId`, `name` (from the connection URL) and `color` (server-assigned) onto
  every relayed peer entry.
- Clients send their **full** state every time (not diffs) — any single message
  fully re-establishes a participant, which makes reconnects self-healing.

### Colors

The server assigns each connection a color from a fixed palette (documented in
[`server/protocol.ts`](server/protocol.ts), `PRESENCE_PALETTE`): the lowest palette
slot not held by another client in the room, wrapping with modulo when exhausted.
The client's own color arrives in `init.color`; peers' colors ride along in every
presence message, so clients never need the palette to render others.

### Client → server: `presence`

```json
{ "type": "presence", "state": { "tab": "designer", "sel": { "...": "..." }, "...": "opaque" } }
```

The server MUST: replace the stored state for this client, and broadcast it to all
**other** clients wrapped in a `peer` entry (below). The server MUST NOT append it
to the log. Recommended guards (reference implementation): silently drop frames
larger than **4096 bytes** (`PRESENCE_MAX_BYTES`) and beyond ~50 messages/second
per client (token bucket, burst 100).

### Server → other clients: `presence`

```json
{ "type": "presence", "peer": { "clientId": "3f2c8b9e-...", "name": "Maria", "color": "#e51a5f", "state": { "...": "opaque" } } }
```

### Server → newcomer: `presence-sync` (immediately after `init`)

If any connected client has sent presence, the server sends the newcomer the whole
roster on the same connection, right after `init` (ordering is guaranteed by the
socket):

```json
{ "type": "presence-sync", "peers": [ { "clientId": "...", "name": "Bob", "color": "#0b7bd0", "state": { } } ] }
```

### Server → remaining clients: `presence-leave` (on disconnect)

```json
{ "type": "presence-leave", "clientId": "3f2c8b9e-..." }
```

Sent for every disconnecting client (even one that never sent presence — receivers
ignore unknown ids). To catch dropped or half-open connections that never send a
clean close, the server runs a WebSocket-level **ping/pong keepalive**: it pings
each socket periodically (reference: every 30 s) and terminates any that fails to
answer, which fires this same `presence-leave`. A browser answers pings at the
WebSocket layer even in a throttled/backgrounded tab, so the reference client does
**not** run its own timer-based staleness sweep — a JS-timer sweep would falsely
drop an idle observer whose background tab throttled its heartbeat.

## Room lifecycle

- Created by `POST /api/rooms` (explicit seed) or on first WS connect (seed `{}`).
- When the last client disconnects, start a TTL timer (reference default: 30 minutes,
  env `EMPTY_ROOM_TTL_MS`). If nobody reconnects before it fires, delete the room.
  A reconnect cancels the timer.
- Deleting a room loses its state; a later connect auto-creates a fresh empty one.

## Ordering & consistency guarantees the server must provide

1. **Per-room total order**: all clients observe records in the same order the server
   appended them. Process a room's messages sequentially.
2. **Init atomicity**: the `init` snapshot (seed + log) plus subsequent `record`
   messages must not lose or reorder records for that client. Easiest implementation:
   register the client and send `init` in the same synchronous step that gates
   broadcasts (as the reference implementation does).
3. **No echo**: never send a client its own record.

Nothing else is required — conflict resolution is entirely client-side (last write
wins at the level of individual survey properties).

## Static serving (optional, not part of the protocol)

The reference server also serves the demo UI: the lobby at `/` and the built clients at
`/react/`, `/vue/`, `/js/`, `/angular/`. A production server may host the UI elsewhere;
only `/api/*` and `/ws/*` are the protocol surface.
