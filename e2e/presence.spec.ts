import { test, expect, type Locator, type Page } from "@playwright/test";
import WebSocket from "ws";
import { createRoom, questionLocator, uniqueRoomId } from "./utils";

/**
 * Does the node's computed box-shadow use its own --collab-peer-color?
 * True = the remote-focus ring is drawn in the peer's color; false = either
 * no decoration or the native (local-priority) ring.
 */
async function ringShowsPeerColor(node: Locator): Promise<boolean> {
    return node.evaluate((el) => {
        const hex = getComputedStyle(el).getPropertyValue("--collab-peer-color").trim();
        if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
        const n = parseInt(hex.slice(1), 16);
        const rgb = `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
        return getComputedStyle(el).boxShadow.includes(rgb);
    });
}

const WS_BASE = "ws://localhost:8080";

/**
 * Minimal protocol-level WS client (runs in Node, not the browser): buffers
 * every server message and lets tests await one matching a predicate.
 */
class ProtoClient {
    private readonly messages: any[] = [];
    private waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    private constructor(private readonly ws: WebSocket) {}

    static async connect(roomId: string, name?: string): Promise<ProtoClient> {
        const query = name !== undefined ? `?name=${encodeURIComponent(name)}` : "";
        const ws = new WebSocket(`${WS_BASE}/ws/rooms/${encodeURIComponent(roomId)}${query}`);
        const client = new ProtoClient(ws);
        ws.on("message", (data) => {
            const msg = JSON.parse(data.toString());
            const waiter = client.waiters.find((w) => w.pred(msg));
            if (waiter) {
                client.waiters = client.waiters.filter((w) => w !== waiter);
                waiter.resolve(msg);
            } else {
                client.messages.push(msg);
            }
        });
        await new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
        });
        return client;
    }

    send(obj: unknown): void {
        this.ws.send(JSON.stringify(obj));
    }

    /** Next (or already buffered) message matching `pred`. */
    next(pred: (m: any) => boolean, timeoutMs = 10_000): Promise<any> {
        const idx = this.messages.findIndex(pred);
        if (idx >= 0) return Promise.resolve(this.messages.splice(idx, 1)[0]);
        return new Promise((resolve, reject) => {
            const waiter = { pred, resolve: (m: any) => { clearTimeout(timer); resolve(m); } };
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((w) => w !== waiter);
                reject(new Error(`timed out waiting for message (${timeoutMs}ms)`));
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }

    /** Assert no buffered/arriving message matches `pred` within `windowMs`. */
    async expectNone(pred: (m: any) => boolean, windowMs = 750): Promise<void> {
        await expect(this.next(pred, windowMs)).rejects.toThrow(/timed out/);
    }

    close(): void {
        this.ws.close();
    }
}

test.describe("presence protocol", () => {
    test("init carries a color; roster sync reaches the newcomer; relay has no echo", async () => {
        const roomId = uniqueRoomId("pres-sync");
        const a = await ProtoClient.connect(roomId, "A");
        const initA = await a.next((m) => m.type === "init");
        expect(typeof initA.color).toBe("string");

        a.send({ type: "presence", state: { tab: "designer" } });
        // No echo: A never receives its own presence back.
        await a.expectNone((m) => m.type === "presence");

        const b = await ProtoClient.connect(roomId, "B");
        const initB = await b.next((m) => m.type === "init");
        expect(initB.color).not.toBe(initA.color);

        // The server stamps the name (from the ?name= connect param) onto the
        // envelope; the state itself carries no identity.
        const sync = await b.next((m) => m.type === "presence-sync");
        expect(sync.peers).toHaveLength(1);
        expect(sync.peers[0].clientId).toBe(initA.clientId);
        expect(sync.peers[0].color).toBe(initA.color);
        expect(sync.peers[0].name).toBe("A");
        expect(sync.peers[0].state.name).toBeUndefined();

        // Live relay: B's update reaches A wrapped in a name-stamped peer entry.
        b.send({ type: "presence", state: { tab: "theme" } });
        const update = await a.next((m) => m.type === "presence");
        expect(update.peer.clientId).toBe(initB.clientId);
        expect(update.peer.name).toBe("B");
        expect(update.peer.state.tab).toBe("theme");

        a.close();
        b.close();
    });

    test("a client connecting without ?name= is presented as Guest", async () => {
        const roomId = uniqueRoomId("pres-guest");
        const anon = await ProtoClient.connect(roomId);
        await anon.next((m) => m.type === "init");
        // send() is fire-and-forget; an observer's relayed copy proves the
        // server stored the state before B connects and expects it in the sync.
        const obs = await ProtoClient.connect(roomId, "Obs");
        await obs.next((m) => m.type === "init");
        anon.send({ type: "presence", state: { tab: "designer" } });
        await obs.next((m) => m.type === "presence");

        const b = await ProtoClient.connect(roomId, "B");
        await b.next((m) => m.type === "init");
        // The observer never announced presence, so the sync holds anon only.
        const sync = await b.next((m) => m.type === "presence-sync");
        expect(sync.peers).toHaveLength(1);
        expect(sync.peers[0].name).toBe("Guest");

        anon.close();
        obs.close();
        b.close();
    });

    test("leave broadcast on disconnect; roster forgets the leaver; color slot is reused", async () => {
        const roomId = uniqueRoomId("pres-leave");
        const a = await ProtoClient.connect(roomId, "A");
        const initA = await a.next((m) => m.type === "init");

        const b = await ProtoClient.connect(roomId, "B");
        await b.next((m) => m.type === "init");
        // B connects BEFORE A announces, so A's frame reaches it as a live
        // relay — no fire-and-forget race against B's upgrade handshake.
        a.send({ type: "presence", state: { tab: "designer" } });
        await b.next((m) => m.type === "presence");

        a.close();
        const leave = await b.next((m) => m.type === "presence-leave");
        expect(leave.clientId).toBe(initA.clientId);

        // C takes A's freed color slot and gets a roster without A.
        const c = await ProtoClient.connect(roomId);
        const initC = await c.next((m) => m.type === "init");
        expect(initC.color).toBe(initA.color);
        await c.expectNone((m) => m.type === "presence-sync" && m.peers.some((p: any) => p.clientId === initA.clientId));

        b.close();
        c.close();
    });

    test("presence never enters the room log; oversized frames are dropped", async ({ request }) => {
        const roomId = uniqueRoomId("pres-log");
        const a = await ProtoClient.connect(roomId, "A");
        await a.next((m) => m.type === "init");
        const b = await ProtoClient.connect(roomId, "B");
        await b.next((m) => m.type === "init");

        for (let i = 0; i < 20; i++) a.send({ type: "presence", state: { i } });
        await b.next((m) => m.type === "presence" && m.peer.state.i === 19);

        const info = await (await request.get(`/api/rooms/${roomId}`)).json();
        expect(info.logLength).toBe(0);

        // A frame over PRESENCE_MAX_BYTES is silently dropped, not relayed.
        a.send({ type: "presence", state: { pad: "x".repeat(5000) } });
        await b.expectNone((m) => m.type === "presence" && m.peer.state.pad);

        // The cap counts BYTES, not UTF-16 units: 3000 CJK chars are only
        // 3000 units but ~9 KB of UTF-8 and must be dropped as well.
        a.send({ type: "presence", state: { pad: "语".repeat(3000) } });
        await b.expectNone((m) => m.type === "presence" && m.peer.state.pad);

        // The connection survives and ordinary records still relay (old-style
        // append-only clients are unaffected by the presence extension).
        a.send({ type: "append", payload: { hello: 1 } });
        const rec = await b.next((m) => m.type === "record");
        expect(rec.payload.hello).toBe(1);

        a.close();
        b.close();
    });
});

// ---------------------------------------------------------------------------
// Browser-level: two Creator tabs in one room see each other.

async function openRoomAs(page: Page, roomId: string, name: string): Promise<void> {
    // openRoom() waits for the WS init frame; the extra param carries the
    // presence display name (both tabs share the context's localStorage, so
    // each must pin its own name explicitly).
    const initReceived = new Promise<void>((resolve) => {
        page.on("websocket", (ws) => {
            if (!ws.url().includes("/ws/rooms/")) return;
            ws.on("framereceived", (frame) => {
                if (typeof frame.payload === "string" && frame.payload.includes("\"type\":\"init\"")) resolve();
            });
        });
    });
    await page.goto(`/react/?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name)}`);
    await initReceived;
    await expect(page.locator(".svc-toolbox__item").first()).toBeVisible();
}

test.describe("presence UI", () => {
    test("participant chips, selection outline, tab state and remote cursor", async ({ page, context }) => {
        const roomId = uniqueRoomId("pres-ui");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q1", title: "Question 1" }] }]
        });

        const alice = page;
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await openRoomAs(bob, roomId, "Bob");

        // Both see each other in the status bar (peers exclude self).
        await expect(alice.locator(".svc-collab-bar__participant")).toHaveCount(1);
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toBeVisible();
        await expect(bob.locator('.svc-collab-bar__participant[title*="Alice"]')).toBeVisible();

        // Bob selects q1 → Alice sees the native-style ring on HER q1 content
        // node, drawn in Bob's color.
        await questionLocator(bob, "q1").click();
        const aliceRing = alice.locator('[data-sv-drop-target-survey-element="q1"] > .svc-question__content');
        await expect(aliceRing).toHaveAttribute("data-collab-focus", "on");
        await expect(async () => {
            expect(await ringShowsPeerColor(aliceRing)).toBe(true);
        }).toPass({ timeout: 10_000 });

        // ...with Bob's name badge under the ring's bottom-right corner: it
        // hangs 4px below the ring's outer edge (node rect + 2px box-shadow),
        // right edge 8px inside the ring's right edge.
        const aliceBadge = alice.locator(".collab-presence-badge", { hasText: "Bob" });
        await expect(aliceBadge).toBeVisible();
        await expect(async () => {
            const ring = (await aliceRing.boundingBox())!;
            const badge = (await aliceBadge.boundingBox())!;
            expect(Math.abs(badge.x + badge.width - (ring.x + ring.width - 6))).toBeLessThanOrEqual(3);
            expect(Math.abs(badge.y - (ring.y + ring.height + 6))).toBeLessThanOrEqual(3);
        }).toPass({ timeout: 10_000 });

        // Local priority: Alice selects q1 herself → her native selection ring
        // wins, Bob's colored ring is suppressed on that node - but the badge
        // stays: Alice still sees who else is on the element.
        await questionLocator(alice, "q1").click();
        await expect(async () => {
            expect(await ringShowsPeerColor(aliceRing)).toBe(false);
        }).toPass({ timeout: 10_000 });
        await expect(aliceBadge).toBeVisible();

        // Bob moves his mouse over q1 → Alice sees his labeled cursor.
        const box = (await questionLocator(bob, "q1").boundingBox())!;
        await bob.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
        await bob.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
        await expect(alice.locator(".collab-presence-cursor-name", { hasText: "Bob" })).toBeVisible();

        // Bob switches to the Preview tab → Alice's chip for Bob reflects it
        // in its tooltip, and his ring disappears from the designer: the
        // shared state only describes what Bob does NOW, so his selection is
        // cleared together with the tab (no "away" ghosts).
        await bob.locator("#tab-test, #tab-preview").first().click();
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toHaveAttribute("title", /Bob on (Preview|test)/);
        await expect(alice.locator("[data-collab-focus]")).toHaveCount(0);
        await expect(aliceBadge).toBeHidden();

        // Bob returns to the designer: his selection is re-announced from his
        // model and the ring comes back without any new click.
        await bob.locator("#tab-designer").click();
        await expect(aliceRing).toHaveAttribute("data-collab-focus", "on");

        // Bob leaves → all of Bob's artifacts disappear on Alice's side.
        await bob.close();
        await expect(alice.locator(".svc-collab-bar__participant")).toHaveCount(0);
        await expect(alice.locator("[data-collab-focus]")).toHaveCount(0);
        await expect(alice.locator(".collab-presence-badge")).toHaveCount(0);
        await expect(alice.locator(".collab-presence-cursor")).toBeHidden();
    });

    test("participant chips are not rebuilt on presence ticks that don't change the roster", async ({ page, context }) => {
        const roomId = uniqueRoomId("pres-norebuild");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q1", title: "Question 1" }] }]
        });

        const alice = page;
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await openRoomAs(bob, roomId, "Bob");

        const chip = alice.locator('.svc-collab-bar__participant[title*="Bob"]');
        await expect(chip).toBeVisible();
        // Tag the current chip node; a full rebuild (replaceChildren) would drop it.
        await chip.evaluate((el) => el.setAttribute("data-persist-check", "1"));

        // Bob generates a stream of presence updates whose roster fields
        // (name/color/tab) never change: a selection then cursor moves.
        await questionLocator(bob, "q1").click();
        const box = (await questionLocator(bob, "q1").boundingBox())!;
        await bob.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
        await bob.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
        // Proof the updates actually reached Alice (so setParticipants ran).
        await expect(alice.locator(".collab-presence-cursor-name", { hasText: "Bob" })).toBeVisible();

        // The chip node survived: no rebuild happened for a roster that didn't change.
        await expect(alice.locator('.svc-collab-bar__participant[data-persist-check="1"]')).toHaveCount(1);

        // A real roster change (Bob switches tab) DOES refresh the chip: its
        // title reflects the new tab and the stale tagged node is gone.
        await bob.locator("#tab-test, #tab-preview").first().click();
        await expect(alice.locator(".svc-collab-bar__participant").first()).toHaveAttribute("title", /Bob on (Preview|test)/);
        await expect(alice.locator('.svc-collab-bar__participant[data-persist-check="1"]')).toHaveCount(0);

        await bob.close();
    });

    test("clicking a participant (chip or overflow list) follows them to their tab", async ({ page, context }) => {
        const roomId = uniqueRoomId("follow-tab");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q1" }] }]
        });

        const alice = page;
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await openRoomAs(bob, roomId, "Bob");

        // Bob goes to Logic → clicking his chip switches Alice from Designer to Logic.
        await bob.locator("#tab-logic").click();
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toHaveAttribute("title", /Bob on Logic/);
        await expect(alice.locator(".svc-toolbox").first()).toBeVisible();
        await alice.locator('.svc-collab-bar__participant[title*="Bob"]').click();
        await expect(alice.locator(".svc-logic-tab").first()).toBeVisible();

        // Bob back to Designer → clicking his row in the overflow list follows him.
        await bob.locator("#tab-designer").click();
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toHaveAttribute("title", /Bob on Designer/);
        await alice.getByRole("button", { name: "Participants" }).click();
        await alice.locator(".svc-collab-bar__roster-item", { hasText: "Bob" }).click();
        await expect(alice.locator(".svc-toolbox").first()).toBeVisible();

        await bob.close();
    });

    test("remote cursor lands on the same survey spot when the windows differ in width", async ({ page, context }) => {
        const roomId = uniqueRoomId("pres-size");
        // responsive width: the survey canvas stretches with the window, so
        // the two peers' canvas blocks genuinely differ in width (the default
        // static mode gives both a fixed 672px block, which maps trivially).
        await createRoom(page, roomId, {
            widthMode: "responsive",
            pages: [
                { name: "p1", elements: [{ type: "text", name: "q1" }] },
                { name: "p2", elements: [{ type: "text", name: "q2" }] }
            ]
        });

        // Alice (receiver) has a much narrower window than Bob (sender), so
        // every layout box - toolbox, canvas, pages - differs between them.
        // Element/page-anchored cursors travel as fractions of the shared DOM
        // anchor; canvas ("surface") cursors travel as px offsets from the
        // survey canvas block, edge-mapped onto the receiver's block - either
        // way the cursor must land on the same SURVEY spot, not the same pixels.
        const alice = page;
        await alice.setViewportSize({ width: 1000, height: 1100 });
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await bob.setViewportSize({ width: 1450, height: 1100 });
        await openRoomAs(bob, roomId, "Bob");
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toBeVisible();

        const rect = (p: Page, selector: string) =>
            p.locator(selector).first().evaluate((el) => {
                const r = el.getBoundingClientRect();
                return { left: r.left, top: r.top, width: r.width, height: r.height };
            });

        // Bob hovers the point at fractions (fx, fy) of HIS anchor box; Alice
        // must render his cursor at the same fractions of HER anchor box.
        // Tolerance: fractions are wire-rounded to 3 decimals and the cursor
        // is placed on whole pixels.
        // The hover is INSIDE the retry: early attempts can race the initial
        // layout settling, so each retry re-measures and re-hovers.
        const expectMapped = async (anchorSelector: string, fx: number, fy: number) => {
            await expect(async () => {
                const b = await rect(bob, anchorSelector);
                await bob.mouse.move(b.left + 2, b.top + 2);
                await bob.mouse.move(b.left + b.width * fx, b.top + b.height * fy, { steps: 3 });
                // capture throttle (50ms) + wire coalescing (40ms) + paint
                await bob.waitForTimeout(250);
                const a = await rect(alice, anchorSelector);
                const expected = { x: a.left + a.width * fx, y: a.top + a.height * fy };
                // NOT toBeVisible(): the cursor node is a 0x0 box whose SVG
                // overflows it, and Playwright treats empty boxes as hidden.
                const got = await alice.locator(".collab-presence-cursor").evaluate((el) => ({
                    display: (el as HTMLElement).style.display,
                    x: parseFloat((el as HTMLElement).style.left),
                    y: parseFloat((el as HTMLElement).style.top)
                }));
                expect(got.display).toBe("block");
                expect(Math.abs(got.x - expected.x)).toBeLessThanOrEqual(3);
                expect(Math.abs(got.y - expected.y)).toBeLessThanOrEqual(3);
            }).toPass({ timeout: 20_000 });
        };

        // Over a question: anchored to the question adorner.
        await expectMapped('[data-sv-drop-target-survey-element="q1"]', 1 / 3, 0.5);

        // Over a page's empty area (top strip of page2 above its question):
        // anchored to the page wrapper.
        await expectMapped('[data-sv-drop-target-survey-element="p2"]', 0.75, 0.05);

        // Canvas ("surface") cursors: px offsets from the survey canvas block
        // (the centered node wrapping the header and the pages), edge-mapped
        // onto the receiver's block. This replaces the old fraction contract,
        // which misplaced cursors between differently-sized windows: a cursor
        // beside the survey title rendered ON the title for a wider peer.
        const mapOffsetSpec = (d: number, ws: number, wr: number): number => {
            if (ws === wr) return d;
            if (d < 0) return d;
            if (d > ws) return wr + (d - ws);
            const edge = Math.min(120, ws / 2, wr / 2);
            if (d <= edge) return d;
            if (ws - d <= edge) return wr - (ws - d);
            return edge + (d - edge) * (wr - 2 * edge) / (ws - 2 * edge);
        };
        const canvasRect = (p: Page) =>
            p.evaluate(() => {
                const content = document.querySelector(".svc-tab-designer_content")!;
                const block = content.querySelector(".svc-designer-surface") ?? content;
                const r = block.getBoundingClientRect();
                return { left: r.left, top: r.top, width: r.width, height: r.height };
            });
        let lastCursor = { x: 0, y: 0 };
        const expectSurfacePx = async (bobPoint: () => Promise<{ x: number; y: number }>) => {
            await expect(async () => {
                const bCanvas = await canvasRect(bob);
                const pt = await bobPoint();
                await bob.mouse.move(pt.x - 25, pt.y - 25);
                await bob.mouse.move(pt.x, pt.y, { steps: 3 });
                await bob.waitForTimeout(250);
                const aCanvas = await canvasRect(alice);
                const expected = {
                    x: aCanvas.left + mapOffsetSpec(pt.x - bCanvas.left, bCanvas.width, aCanvas.width),
                    y: aCanvas.top + mapOffsetSpec(pt.y - bCanvas.top, bCanvas.height, aCanvas.height)
                };
                const got = await alice.locator(".collab-presence-cursor").evaluate((el) => ({
                    display: (el as HTMLElement).style.display,
                    x: parseFloat((el as HTMLElement).style.left),
                    y: parseFloat((el as HTMLElement).style.top)
                }));
                expect(got.display).toBe("block");
                expect(Math.abs(got.x - expected.x)).toBeLessThanOrEqual(3);
                expect(Math.abs(got.y - expected.y)).toBeLessThanOrEqual(3);
                lastCursor = got;
            }).toPass({ timeout: 20_000 });
        };

        // THE reported bug: Bob points just left of the survey title text -
        // his cursor must render left of Alice's title too, not on top of it.
        const titleSel = ".svc-designer-header .svc-string-editor";
        await expectSurfacePx(async () => {
            const t = await rect(bob, titleSel);
            return { x: t.left - 12, y: t.top + t.height / 2 };
        });
        const aTitle = await rect(alice, titleSel);
        expect(lastCursor.x).toBeLessThan(aTitle.left);

        // Blank canvas in the side gutter next to page1 - a signed offset
        // left of the canvas block keeps its px distance from that edge.
        await expectSurfacePx(async () => {
            const bContent = await rect(bob, ".svc-tab-designer_content");
            const bPage = await rect(bob, '[data-sv-drop-target-survey-element="p1"]');
            return { x: (bContent.left + bPage.left) / 2, y: bPage.top + bPage.height / 2 };
        });

        // No mid-canvas case here: page/question adorners tile the canvas
        // interior (even the gap between pages belongs to their drop-target
        // boxes), so "surface" only shows near the edges - covered above.
        // The proportional middle branch of mapOffset is unit-tested.

        await bob.close();
    });

    test("canvas cursor maps exactly between windows when the survey width is static", async ({ page, context }) => {
        const roomId = uniqueRoomId("pres-static");
        await createRoom(page, roomId, {
            widthMode: "static",
            pages: [{ name: "p1", elements: [{ type: "text", name: "q1" }] }]
        });

        // With a static survey width the canvas block is centered and has the
        // SAME size on both peers, so canvas px offsets map 1:1 even though
        // the windows (hence the gutters around the block) differ. Fractions
        // of the content box - the old contract - could not express this.
        const alice = page;
        await alice.setViewportSize({ width: 1000, height: 1100 });
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await bob.setViewportSize({ width: 1900, height: 1100 });
        await openRoomAs(bob, roomId, "Bob");
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toBeVisible();

        const canvasRect = (p: Page) =>
            p.evaluate(() => {
                const content = document.querySelector(".svc-tab-designer_content")!;
                const block = content.querySelector(".svc-designer-surface") ?? content;
                const r = block.getBoundingClientRect();
                return { left: r.left, top: r.top, width: r.width, height: r.height };
            });

        await expect(async () => {
            const bCanvas = await canvasRect(bob);
            const aCanvas = await canvasRect(alice);
            // The whole point of the static mode: equal canvas blocks.
            expect(Math.abs(bCanvas.width - aCanvas.width)).toBeLessThanOrEqual(1);
            const dx = 30;
            const dy = 40;
            await bob.mouse.move(bCanvas.left + dx + 20, bCanvas.top + dy + 20);
            await bob.mouse.move(bCanvas.left + dx, bCanvas.top + dy, { steps: 3 });
            await bob.waitForTimeout(250);
            const got = await alice.locator(".collab-presence-cursor").evaluate((el) => ({
                display: (el as HTMLElement).style.display,
                x: parseFloat((el as HTMLElement).style.left),
                y: parseFloat((el as HTMLElement).style.top)
            }));
            expect(got.display).toBe("block");
            expect(Math.abs(got.x - (aCanvas.left + dx))).toBeLessThanOrEqual(3);
            expect(Math.abs(got.y - (aCanvas.top + dy))).toBeLessThanOrEqual(3);
        }).toPass({ timeout: 20_000 });

        // Bob's much wider window has a huge gutter around the centered
        // canvas. When he points deep into it, Alice's mapped point would
        // land on HER toolbox - instead the cursor must pin to the left edge
        // of her designer column, never reading as "pointing at a tool".
        await expect(async () => {
            const bCanvas = await canvasRect(bob);
            const aColumn = await alice.locator(".svc-tab-designer").first().evaluate((el) => {
                const r = el.getBoundingClientRect();
                return { left: r.left, top: r.top };
            });
            const aCanvas = await canvasRect(alice);
            const dy = 40;
            await bob.mouse.move(bCanvas.left - 130, bCanvas.top + dy + 20);
            await bob.mouse.move(bCanvas.left - 150, bCanvas.top + dy, { steps: 3 });
            await bob.waitForTimeout(250);
            const got = await alice.locator(".collab-presence-cursor").evaluate((el) => ({
                display: (el as HTMLElement).style.display,
                x: parseFloat((el as HTMLElement).style.left),
                y: parseFloat((el as HTMLElement).style.top)
            }));
            expect(got.display).toBe("block");
            expect(got.x).toBeGreaterThanOrEqual(aColumn.left);
            expect(got.x).toBeLessThanOrEqual(aCanvas.left);
            expect(Math.abs(got.y - (aCanvas.top + dy))).toBeLessThanOrEqual(3);
        }).toPass({ timeout: 20_000 });

        await bob.close();
    });

    test("property-grid focus badge is visible in the flyout sidebar", async ({ page, context }) => {
        const roomId = uniqueRoomId("pres-pg-flyout");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q1" }] }]
        });

        // Narrow window → the sidebar opens as a FLYOUT whose visible panel
        // sits OUTSIDE the .svc-side-bar host box (which shrinks to the tabs
        // strip); the badge used to be clipped away against the host box.
        const alice = page;
        await alice.setViewportSize({ width: 1071, height: 618 });
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await bob.setViewportSize({ width: 1071, height: 618 });
        await openRoomAs(bob, roomId, "Bob");

        await alice.locator('.svc-sidebar-tabs button[title="General"]').click();
        await bob.locator('.svc-sidebar-tabs button[title="General"]').click();

        // Bob focuses the Survey title field → Alice (same object selected,
        // the survey) sees the ring AND the name badge on her grid field.
        await bob.locator('.svc-side-bar [data-name="title"] input').first().click();
        const aliceField = alice.locator('.svc-side-bar [data-name="title"] .spg-question__content');
        await expect(aliceField).toHaveAttribute("data-collab-focus", "on");
        const badge = alice.locator(".collab-presence-badge", { hasText: "Bob" });
        await expect(badge).toBeVisible();
        await expect(async () => {
            const f = (await aliceField.boundingBox())!;
            const b = (await badge.boundingBox())!;
            expect(Math.abs(b.x + b.width - (f.x + f.width - 6))).toBeLessThanOrEqual(3);
            expect(Math.abs(b.y - (f.y + f.height + 6))).toBeLessThanOrEqual(3);
        }).toPass({ timeout: 10_000 });

        // A boolean row rings just the checkbox decorator, not the whole
        // row content (which spans the checkbox AND its label).
        await bob.locator('.svc-side-bar [data-name="showTitle"] .sd-checkbox__decorator').click();
        const aliceDecorator = alice.locator('.svc-side-bar [data-name="showTitle"] .sd-checkbox__decorator');
        await expect(aliceDecorator).toHaveAttribute("data-collab-focus", "on");
        await expect(alice.locator('.svc-side-bar [data-name="showTitle"] .spg-question__content[data-collab-focus]')).toHaveCount(0);
        // The badge must not hang out past the ring's left edge on a node
        // this narrow - it grows rightwards from the checkbox instead.
        await expect(async () => {
            const d = (await aliceDecorator.boundingBox())!;
            const b = (await badge.boundingBox())!;
            expect(b.x).toBeGreaterThanOrEqual(d.x - 3);
            expect(Math.abs(b.y - (d.y + d.height + 6))).toBeLessThanOrEqual(3);
        }).toPass({ timeout: 10_000 });

        await bob.close();
    });

    test("designer cursor hides under the opened flyout sidebar", async ({ page, context }) => {
        const roomId = uniqueRoomId("pres-cur-flyout");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q1" }] }]
        });

        // Narrow windows → the sidebar opens as a FLYOUT floating OVER the
        // designer column (z-index 1000), which the fixed presence layer
        // (z-index 1100) would otherwise paint over. Same viewport on both
        // peers keeps their layouts identical, so Bob's cursor maps 1:1 onto
        // Alice's coordinates.
        const alice = page;
        await alice.setViewportSize({ width: 1071, height: 618 });
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await bob.setViewportSize({ width: 1071, height: 618 });
        await openRoomAs(bob, roomId, "Bob");
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toBeVisible();

        // Alice opens her flyout panel; Bob's stays closed.
        await alice.locator('.svc-sidebar-tabs button[title="General"]').click();
        const alicePanel = alice.locator(".svc-side-bar--flyout .svc-side-bar__container");
        await expect(alicePanel).toBeVisible();

        // NOT toBeHidden()/toBeVisible() on the cursor: it is a 0x0 box whose
        // SVG overflows it, and Playwright treats empty boxes as hidden.
        const cursor = () => alice.locator(".collab-presence-cursor").evaluate((el) => ({
            display: (el as HTMLElement).style.display,
            x: parseFloat((el as HTMLElement).style.left)
        }));

        // Bob points at a canvas spot that on Alice's screen lies under the
        // panel → his cursor must not draw on top of it.
        await expect(async () => {
            const panel = (await alicePanel.boundingBox())!;
            const q = (await questionLocator(bob, "q1").boundingBox())!;
            const x = Math.min(q.x + q.width - 20, panel.x + panel.width / 2);
            expect(x).toBeGreaterThan(panel.x + 10); // sanity: the spot IS covered
            await bob.mouse.move(x - 30, q.y + q.height / 2);
            await bob.mouse.move(x, q.y + q.height / 2, { steps: 3 });
            await bob.waitForTimeout(250);
            expect((await cursor()).display).toBe("none");
        }).toPass({ timeout: 20_000 });

        // Left of the panel the same cursor still shows.
        await expect(async () => {
            const panel = (await alicePanel.boundingBox())!;
            const q = (await questionLocator(bob, "q1").boundingBox())!;
            const x = panel.x - 60;
            await bob.mouse.move(x + 30, q.y + q.height / 2);
            await bob.mouse.move(x, q.y + q.height / 2, { steps: 3 });
            await bob.waitForTimeout(250);
            const got = await cursor();
            expect(got.display).toBe("block");
            expect(got.x).toBeLessThan(panel.x);
        }).toPass({ timeout: 20_000 });

        await bob.close();
    });

    test("focusing a translation cell rings it for peers; the ring moves and clears on tab exit", async ({ page, context }) => {
        const roomId = uniqueRoomId("pres-tr");
        // A de translation makes the used locale visible for both peers, so
        // the title row renders two cells: "default" and "de".
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q1", title: { default: "Question 1", de: "Frage 1" } }] }]
        });

        // At the default width the Translations tab collapses into the "More"
        // overflow menu - widen both windows so it is directly clickable.
        const alice = page;
        await alice.setViewportSize({ width: 1600, height: 900 });
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await bob.setViewportSize({ width: 1600, height: 900 });
        await openRoomAs(bob, roomId, "Bob");
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toBeVisible();

        // The ring renders only when the LOCAL client is on the Translations
        // tab too (same gate as the designer decorations) - both go there.
        await alice.locator("#tab-translation").click();
        await bob.locator("#tab-translation").click();
        // Locale cells of the strings table (the header survey and the
        // row-text cells never carry the ring).
        const aliceCells = alice.locator("#scrollableDiv-translation .st-strings td.st-table__cell:not(.st-table__cell--row-text)");
        await expect(aliceCells.first()).toBeVisible();

        // Bob focuses the default-locale textarea → Alice sees exactly that
        // cell ringed in Bob's color, with his name badge under it.
        const bobInputs = bob.locator("#scrollableDiv-translation .st-strings td.st-table__cell textarea");
        await bobInputs.first().click();
        await expect(aliceCells.first()).toHaveAttribute("data-collab-focus", "on");
        await expect(alice.locator("#scrollableDiv-translation [data-collab-focus]")).toHaveCount(1);
        await expect(async () => {
            expect(await ringShowsPeerColor(aliceCells.first())).toBe(true);
        }).toPass({ timeout: 10_000 });
        const aliceBadge = alice.locator(".collab-presence-badge", { hasText: "Bob" });
        await expect(aliceBadge).toBeVisible();
        // The cell's textarea goes transparent while decorated - its opaque
        // background would otherwise paint over the inset ring's side edges.
        const cellTextareaBg = (idx: number) =>
            aliceCells.nth(idx).locator("textarea").evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(await cellTextareaBg(0)).toBe("rgba(0, 0, 0, 0)");

        // Bob moves to the de cell of the same row → the ring follows, the
        // old cell is undecorated (never two rings for one peer).
        await bobInputs.nth(1).click();
        await expect(aliceCells.nth(1)).toHaveAttribute("data-collab-focus", "on");
        await expect(aliceCells.first()).not.toHaveAttribute("data-collab-focus", "on");
        await expect(alice.locator("#scrollableDiv-translation [data-collab-focus]")).toHaveCount(1);
        // The undecorated cell's textarea gets its opaque background back.
        expect(await cellTextareaBg(0)).not.toBe("rgba(0, 0, 0, 0)");
        expect(await cellTextareaBg(1)).toBe("rgba(0, 0, 0, 0)");

        // Local focus wins: when Alice puts her caret into the ringed cell,
        // Bob's decoration leaves it entirely - ring AND badge, no leftovers.
        const aliceInput1 = alice.locator("#scrollableDiv-translation .st-strings td.st-table__cell textarea").nth(1);
        await aliceInput1.click();
        await expect(alice.locator("#scrollableDiv-translation [data-collab-focus]")).toHaveCount(0);
        await expect(aliceBadge).toBeHidden();

        // Her caret leaves - Bob still holds the cell, the decoration returns.
        await aliceInput1.blur();
        await expect(aliceCells.nth(1)).toHaveAttribute("data-collab-focus", "on");
        await expect(aliceBadge).toBeVisible();

        // Bob leaves the tab → his focus cannot survive it (the tab model is
        // disposed), so the ring clears instead of dimming to "away".
        await bob.locator("#tab-designer").click();
        await expect(alice.locator("#scrollableDiv-translation [data-collab-focus]")).toHaveCount(0);

        await bob.close();
    });

    test("both clients in one translation cell: local focus removes the peer decoration, leaving it removes cleanly", async ({ page, context }) => {
        // Regression for the manual-testing report: A focuses a cell, B
        // focuses the SAME cell, A re-focuses it - on B the ring used to
        // vanish while the badge stayed floating, reading as a broken
        // highlight. Local focus must remove the peer decoration ENTIRELY
        // (ring and badge together), and it must come back once the local
        // caret leaves the cell.
        const roomId = uniqueRoomId("pres-tr-samecell");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "text", name: "q1", title: { default: "Question 1", de: "Frage 1" } }] }]
        });

        const alice = page;
        await alice.setViewportSize({ width: 1600, height: 900 });
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await bob.setViewportSize({ width: 1600, height: 900 });
        await openRoomAs(bob, roomId, "Bob");
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toBeVisible();

        await alice.locator("#tab-translation").click();
        await bob.locator("#tab-translation").click();
        const cellSel = "#scrollableDiv-translation .st-strings td.st-table__cell:not(.st-table__cell--row-text)";
        const aliceInput = alice.locator(`${cellSel} textarea`).first();
        const bobInputs = bob.locator(`${cellSel} textarea`);
        const bobCell = bob.locator(cellSel).first();
        const bobBadge = bob.locator(".collab-presence-badge", { hasText: "Alice" });

        // 1) Alice focuses the cell → Bob (not in it) sees her ring + badge.
        await aliceInput.click();
        await expect(bobCell).toHaveAttribute("data-collab-focus", "on");
        await expect(async () => {
            expect(await ringShowsPeerColor(bobCell)).toBe(true);
        }).toPass({ timeout: 10_000 });
        await expect(bobBadge).toBeVisible();

        // 2) Bob focuses the SAME cell → Alice's decoration leaves his screen
        // entirely: no ring, and no badge floating under a ringless cell.
        await bobInputs.first().click();
        await expect(bob.locator("#scrollableDiv-translation [data-collab-focus]")).toHaveCount(0);
        await expect(bobBadge).toBeHidden();

        // 3) Alice re-selects the same cell (the manual repro step) → still
        // nothing on Bob's side while his caret stays in that cell.
        await aliceInput.blur();
        await aliceInput.click();
        await expect(bob.locator("#scrollableDiv-translation [data-collab-focus]")).toHaveCount(0);
        await expect(bobBadge).toBeHidden();

        // 4) Bob moves his caret to another cell → Alice's ring AND badge
        // reappear on the contested cell.
        await bobInputs.nth(1).click();
        await expect(bobCell).toHaveAttribute("data-collab-focus", "on");
        await expect(async () => {
            expect(await ringShowsPeerColor(bobCell)).toBe(true);
        }).toPass({ timeout: 10_000 });
        await expect(bobBadge).toBeVisible();

        await bob.close();
    });

    test("focusing inline editors (choice, question title, survey title) lights the native border for peers", async ({ page, context }) => {
        const roomId = uniqueRoomId("pres-edit");
        await createRoom(page, roomId, {
            pages: [{ name: "p1", elements: [{ type: "dropdown", name: "q1", choices: ["item1", "item2", "item3"] }] }]
        });

        const alice = page;
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await openRoomAs(bob, roomId, "Bob");

        // Bob clicks into the inline text editor of choice "item2" → on
        // Alice's side that editor's native focus border lights up in Bob's
        // color, plus the selection ring appears on q1 (the choice click
        // selects the owning question).
        const bobRow = bob.locator('[data-sv-drop-target-item-value="item2"]');
        await bobRow.locator(".sv-string-editor").first().click();
        const aliceChoiceEditor = alice.locator('[data-sv-drop-target-item-value="item2"] .svc-string-editor');
        await expect(aliceChoiceEditor).toHaveAttribute("data-collab-focus", "on");
        await expect(async () => {
            const borderVisible = await aliceChoiceEditor.evaluate((el) => {
                const border = el.querySelector(".svc-string-editor__border--focus");
                return !!border && getComputedStyle(border).opacity === "1";
            });
            expect(borderVisible).toBe(true);
        }).toPass({ timeout: 10_000 });
        const aliceRing = alice.locator('[data-sv-drop-target-survey-element="q1"] > .svc-question__content');
        await expect(aliceRing).toHaveAttribute("data-collab-focus", "on");

        // The editor's badge anchors to its VISIBLE focus border, which is
        // inflated past the .svc-string-editor rect (-4px/-8px offsets). Two
        // badges are up (q1 ring + editor) in a tick-dependent DOM order, so
        // look for the one hugging the border's bottom-right corner.
        await expect(async () => {
            const border = (await aliceChoiceEditor.locator(".svc-string-editor__border--focus").boundingBox())!;
            const badges = await alice.locator(".collab-presence-badge").all();
            const boxes = await Promise.all(badges.map((b) => b.boundingBox()));
            expect(boxes.some((b) => !!b &&
                Math.abs(b.x + b.width - (border.x + border.width - 6)) <= 3 &&
                Math.abs(b.y - (border.y + border.height + 6)) <= 3)).toBe(true);
        }).toPass({ timeout: 10_000 });

        // Bob moves into the question TITLE editor → the border follows.
        await questionLocator(bob, "q1").locator(".sd-question__title .sv-string-editor").first().click();
        await expect(alice.locator('[data-sv-drop-target-survey-element="q1"] .sd-question__title .svc-string-editor'))
            .toHaveAttribute("data-collab-focus", "on");
        await expect(alice.locator('[data-sv-drop-target-item-value="item2"] .svc-string-editor[data-collab-focus]')).toHaveCount(0);

        // Bob edits the SURVEY title in the designer header.
        await bob.locator(".svc-designer-header .sv-string-editor").first().click();
        await expect(alice.locator(".svc-designer-header .svc-string-editor[data-collab-focus]")).toHaveCount(1);

        // Bob leaves → no decorations remain.
        await bob.close();
        await expect(alice.locator("[data-collab-focus]")).toHaveCount(0);
    });
});
