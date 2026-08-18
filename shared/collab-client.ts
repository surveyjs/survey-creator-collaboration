/**
 * Framework-agnostic collaboration wiring: the creator's CollaborationPlugin ↔
 * WebSocket.
 *
 * This module has ZERO runtime imports on purpose. It is compiled
 * independently by four differently-built client apps (Vite×3 + Angular CLI);
 * importing "survey-creator-core" from here would resolve to a *second* copy
 * of the library and break survey-core's Serializer singleton. Instead the
 * caller creates the creator and the plugins from ITS OWN dependency copy and
 * injects them (structural typing below). Type-only imports are fine — they
 * are erased at build.
 *
 * Usage (identical in every client):
 *   const creator = new SurveyCreator(...);            // framework-specific
 *   const collab = new CollaborationPlugin(creator, { roomId });
 *   creator.addPlugin("collaboration", collab);
 *   const connection = connectCollab({ creator, collab, roomId });
 *
 * Presence responsibilities are split: the plugin determines the state
 * (focus/selection/cursor) and renders remote peers; this module only
 * moves the opaque state over the wire (send-throttled) and routes the
 * server's user-stamped envelopes ({clientId, name, color, state}) into the
 * plugin's roster. Liveness is the server's job: its WS ping/pong keepalive
 * detects dead connections and broadcasts the leave, so this module does NOT
 * time out peers itself (a timer-based sweep would falsely drop an idle peer
 * whose background tab throttled its heartbeat).
 */
import type { IPresencePeerEntry } from "../server/protocol";

/** Structural mirror of survey-creator-core's EventBase — only what we use. */
export interface IJournalEvent {
    add(handler: (sender: unknown, options: { record: unknown }) => void): void;
    remove(handler: (sender: unknown, options: { record: unknown }) => void): void;
}

/** The journal half of the CollaborationPlugin surface we use. */
export interface IJournalPluginLike {
    onRecordAdded: IJournalEvent;
    onRecordChanged: IJournalEvent;
    apply(input: unknown): unknown;
}

/**
 * Structural mirror of survey-creator-core's IJournalRecord — the shape a
 * "version history" view needs. Kept local (not imported) per the zero-runtime
 * -imports rule; the fields match journal-record.ts (`op` is the numeric
 * JournalOp, `payload` carries the change's target/value).
 */
export interface IRoomChange {
    seq: number;
    timestamp: number;
    op: number;
    payload: any;
}

export interface IPresenceEvent {
    add(handler: (sender: unknown, options: unknown) => void): void;
    remove(handler: (sender: unknown, options: unknown) => void): void;
}

/** The presence half of the CollaborationPlugin surface we use. */
export interface IPresencePluginLike {
    onStateChanged: IPresenceEvent;
    /** Fires on every roster mutation (setPeers/upsertPeer/removePeer/clearPeers). */
    onPeersChanged: IPresenceEvent;
    getState(): unknown;
    readonly peers: ReadonlyMap<string, IPresencePeerEntry>;
    setPeers(entries: IPresencePeerEntry[]): void;
    upsertPeer(entry: IPresencePeerEntry): void;
    removePeer(clientId: string): void;
    clearPeers(): void;
}

/** Structural mirror of the creator — we only set its survey JSON. */
export interface ICreatorLike {
    JSON: unknown;
}

export type CollabStatus = "connecting" | "connected" | "closed";

/**
 * The creator's CollaborationPlugin plays both roles: it owns the journal and
 * the presence roster and exposes both surfaces directly.
 */
export type ICollabPluginLike = IJournalPluginLike & IPresencePluginLike;

export interface ICollabOptions {
    creator: ICreatorLike;
    collab: ICollabPluginLike;
    roomId: string;
    /** Override the WS origin, e.g. "ws://localhost:8080". Default: same origin. */
    wsBase?: string;
    onStatus?: (status: CollabStatus) => void;
    /**
     * Display name sent to the server in the connection URL (?name=); the
     * server stamps it onto every relayed peer envelope. Default: getDisplayName().
     */
    name?: string;
    /** The peer roster changed (join/update/leave). Excludes self. */
    onPresence?: (peers: ReadonlyMap<string, IPresencePeerEntry>) => void;
    /**
     * The room's change history grew or a record was updated in place. Carries
     * every journal record the room has seen — the init log (history to date),
     * remote records, and this client's local edits — in arrival order. Backs
     * the "Show Version History" view. Not derivable from `collab.records`,
     * which holds this client's LOCAL edits only (applied remote/init records
     * are suppressed from it via `recorder.isApplying`).
     */
    onHistoryChanged?: (changes: ReadonlyArray<IRoomChange>) => void;
}

export interface ICollabConnection {
    dispose(): void;
}

/** Outgoing presence is coalesced to at most one message per this interval. */
const PRESENCE_SEND_MS = 40;

export function connectCollab(opts: ICollabOptions): ICollabConnection {
    const { creator, roomId } = opts;
    // The two roles the one plugin plays, named apart for readability below.
    const plugin: IJournalPluginLike = opts.collab;
    const presence: IPresencePluginLike = opts.collab;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const base = opts.wsBase ?? `${proto}//${location.host}`;
    const name = opts.name ?? getDisplayName();
    const ws = new WebSocket(`${base}/ws/rooms/${encodeURIComponent(roomId)}?name=${encodeURIComponent(name)}`);
    opts.onStatus?.("connecting");

    // Gate outgoing records until the init bootstrap has been applied.
    let ready = false;

    // --- room change history (Show Version History) ----------------------------
    // Accumulated from all three record sources; onRecordChanged mutates entries
    // in place (coalescing), so we keep references and just re-emit.
    const history: IRoomChange[] = [];
    const emitHistory = (): void => opts.onHistoryChanged?.(history);
    const recordHistory = (record: unknown): void => {
        if (!!record && typeof record === "object") history.push(record as IRoomChange);
    };

    // --- presence: own state (owned by the plugin, only shipped from here) ----
    let clientId: string | null = null;

    let lastSentAt = 0;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    const sendPresenceNow = (): void => {
        sendTimer = undefined;
        if (!ready || ws.readyState !== WebSocket.OPEN) return;
        lastSentAt = Date.now();
        ws.send(JSON.stringify({ type: "presence", state: presence.getState() }));
    };
    const schedulePresenceSend = (): void => {
        if (sendTimer !== undefined) return;
        const elapsed = Date.now() - lastSentAt;
        if (elapsed >= PRESENCE_SEND_MS) sendPresenceNow();
        else sendTimer = setTimeout(sendPresenceNow, PRESENCE_SEND_MS - elapsed);
    };
    const stateChanged = (): void => schedulePresenceSend();
    presence.onStateChanged.add(stateChanged);

    // --- presence: peers (roster lives in the plugin) --------------------------
    // The plugin fires onPeersChanged on every roster mutation — that single
    // subscription is the caller's notification path; no manual bookkeeping.
    const peersChanged = (): void => opts.onPresence?.(presence.peers);
    presence.onPeersChanged.add(peersChanged);
    const isPeerEntry = (entry: IPresencePeerEntry | undefined): entry is IPresencePeerEntry =>
        !!entry && entry.clientId !== clientId && !!entry.state;

    ws.addEventListener("message", (ev) => {
        let msg: any;
        try {
            msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
            return;
        }
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "init") {
            clientId = typeof msg.clientId === "string" ? msg.clientId : null;
            // Fresh socket → fresh roster; a presence-sync follows on this socket.
            presence.clearPeers();
            // Bootstrap order matters: seed does NOT produce journal records,
            // then the log replays in server order (apply() suppresses echo).
            creator.JSON = msg.seed ?? {};
            if (Array.isArray(msg.log) && msg.log.length > 0) {
                plugin.apply(msg.log);
                for (const record of msg.log) recordHistory(record);
                emitHistory();
            }
            ready = true;
            opts.onStatus?.("connected");
            // Announce ourselves so existing occupants see the newcomer at once.
            schedulePresenceSend();
        } else if (msg.type === "record") {
            plugin.apply(msg.payload);
            recordHistory(msg.payload);
            emitHistory();
        } else if (msg.type === "presence-sync") {
            const peers = Array.isArray(msg.peers) ? (msg.peers as IPresencePeerEntry[]).filter(isPeerEntry) : [];
            presence.setPeers(peers);
        } else if (msg.type === "presence") {
            if (isPeerEntry(msg.peer)) presence.upsertPeer(msg.peer);
        } else if (msg.type === "presence-leave") {
            presence.removePeer(msg.clientId);
        }
    });

    const sendRecord = (_: unknown, options: { record: unknown }): void => {
        if (ready && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "append", payload: options.record }));
        }
    };
    // A local edit: ship it and add it to the room history.
    const onLocalRecordAdded = (sender: unknown, options: { record: unknown }): void => {
        sendRecord(sender, options);
        recordHistory(options.record);
        emitHistory();
    };
    // A coalesced record was updated in place — re-send it; the server appends
    // it as a new log entry and replay converges (last write wins). The history
    // entry is the same object reference, already updated — just re-emit.
    const onLocalRecordChanged = (sender: unknown, options: { record: unknown }): void => {
        sendRecord(sender, options);
        emitHistory();
    };
    plugin.onRecordAdded.add(onLocalRecordAdded);
    plugin.onRecordChanged.add(onLocalRecordChanged);

    // The plugins outlive the socket — unhook every handler or each reconnect
    // stacks another dead closure retaining the old WebSocket.
    let disposed = false;
    const cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        if (sendTimer !== undefined) clearTimeout(sendTimer);
        // No frozen cursors: the roster dies with the connection. Clear BEFORE
        // detaching so the caller still hears the final empty roster.
        presence.clearPeers();
        presence.onStateChanged.remove(stateChanged);
        presence.onPeersChanged.remove(peersChanged);
        plugin.onRecordAdded.remove(onLocalRecordAdded);
        plugin.onRecordChanged.remove(onLocalRecordChanged);
        opts.onStatus?.("closed");
    };
    ws.addEventListener("close", cleanup);

    return {
        dispose(): void {
            cleanup();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        }
    };
}

/** Room id from the page URL (?room=...); every client redirects to "/" without it. */
export function getRoomIdFromUrl(): string | null {
    return new URLSearchParams(location.search).get("room");
}

/** Local copy of protocol.ts's truncateCodePoints (zero-runtime-imports rule).
 * String#slice counts UTF-16 units and can leave a lone surrogate that makes
 * encodeURIComponent throw on every subsequent connect. */
const truncateName = (s: string): string => [...s].slice(0, 32).join("");

/**
 * Display name for presence: ?name= param (set by the lobby; needed in dev
 * where lobby and clients run on different origins) → localStorage → a
 * generated guest name. Whatever wins is persisted for the next visit.
 */
export function getDisplayName(): string {
    const fromUrl = truncateName((new URLSearchParams(location.search).get("name") ?? "").trim());
    let name = fromUrl;
    try {
        if (!name) name = truncateName((localStorage.getItem("collab.name") ?? "").trim());
        if (!name) name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
        localStorage.setItem("collab.name", name);
    } catch {
        if (!name) name = `Guest-${Math.random().toString(36).slice(2, 6)}`;
    }
    return name;
}
