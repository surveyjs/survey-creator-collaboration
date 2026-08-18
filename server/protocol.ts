/**
 * Wire protocol types — the TypeScript rendering of PROTOCOL.md.
 *
 * This file has ZERO imports on purpose: it is shared by the server and by all
 * client apps (each bundler compiles it independently), and it documents the
 * language-agnostic protocol. Journal records and survey JSON are `unknown`
 * everywhere — the server stores and forwards them without inspection.
 */

/** Room ids are chosen by clients and must match this pattern. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// HTTP

/** GET /api/rooms/:id → 200 */
export interface IRoomInfo {
    roomId: string;
    exists: true;
    clientCount: number;
    logLength: number;
}

/** POST /api/rooms request body. `seed` is the initial survey JSON (opaque). */
export interface ICreateRoomRequest {
    roomId: string;
    seed?: unknown;
}

/** POST /api/rooms → 201 */
export interface ICreateRoomResponse {
    roomId: string;
}

// ---------------------------------------------------------------------------
// WebSocket /ws/rooms/:id

/** client → server: "my local edit" — the server appends `payload` to the room log. */
export interface IAppendMsg {
    type: "append";
    payload: unknown;
}

/**
 * client → server: this client's FULL presence state (not a diff) — replaces
 * whatever the server stored for this client. Ephemeral: never enters the log.
 * Opaque to the server; the client-side shape is a creator-side convention
 * (survey-creator-core's CollaborationPlugin / IPresenceState). Full-state messages
 * make presence self-healing: any single message fully re-establishes the
 * participant. User identity is NOT in the state — the server stamps it onto
 * the relayed envelope (see IPresencePeerEntry).
 */
export interface IPresenceMsg {
    type: "presence";
    state: unknown;
}

export type ClientToServer = IAppendMsg | IPresenceMsg;

/**
 * server → client, once right after connect: bootstrap state.
 * The client does `creator.JSON = seed`, then applies `log` in array order.
 */
export interface IInitMsg {
    type: "init";
    clientId: string;
    /** This client's presence color, server-assigned from PRESENCE_PALETTE. */
    color: string;
    seed: unknown;
    log: unknown[];
}

/**
 * server → every client in the room except the author: a peer's edit.
 * The receiver applies `payload`; `from` is the author's clientId
 * (defensive echo filtering + debugging).
 */
export interface IRecordMsg {
    type: "record";
    from: string;
    payload: unknown;
}

// ---------------------------------------------------------------------------
// Presence (ephemeral — never enters the room log)

/**
 * Presence colors. The server assigns each connection the lowest palette slot
 * not held by another client in the room (wrapping with modulo if exhausted),
 * so colors are stable and collision-free per room.
 */
export const PRESENCE_PALETTE: readonly string[] = [
    "#e51a5f", "#0b7bd0", "#1e8a4f", "#b78600", "#7a3fd1",
    "#d1571e", "#0a8f8f", "#c2185b", "#5567d3", "#6a8a1e"
];

/** The server silently drops presence frames larger than this many bytes. */
export const PRESENCE_MAX_BYTES = 4096;

/**
 * Maximum display-name length; the server trims longer names. Names come from
 * the `?name=` query param of the WS connection URL (`/ws/rooms/:id?name=...`);
 * a missing/empty name becomes "Guest".
 */
export const PRESENCE_NAME_MAX = 32;

/**
 * Truncate to at most `max` Unicode code points. String#slice counts UTF-16
 * units and can cut a surrogate pair in half, leaving a lone surrogate that
 * strict JSON decoders reject; every name trim (server and clients) uses this.
 */
export function truncateCodePoints(s: string, max: number): string {
    return [...s].slice(0, max).join("");
}

/** One roster entry as the server knows it. `state` is opaque to the server. */
export interface IPresencePeerEntry {
    clientId: string;
    /** Display name from the connection URL's `?name=` param, sanitized by the server. */
    name: string;
    /** Hex color from PRESENCE_PALETTE, server-assigned. */
    color: string;
    /** The last presence state this peer sent. */
    state: unknown;
}

/** server → every client except the author: a peer's presence changed. */
export interface IPresenceUpdateMsg {
    type: "presence";
    peer: IPresencePeerEntry;
}

/**
 * server → newcomer, immediately after `init` on the same connection:
 * everyone in the room who has sent presence so far.
 */
export interface IPresenceSyncMsg {
    type: "presence-sync";
    peers: IPresencePeerEntry[];
}

/** server → remaining clients: a client disconnected. */
export interface IPresenceLeaveMsg {
    type: "presence-leave";
    clientId: string;
}

export type ServerToClient =
    IInitMsg | IRecordMsg | IPresenceUpdateMsg | IPresenceSyncMsg | IPresenceLeaveMsg;
