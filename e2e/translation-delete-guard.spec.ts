import { test, expect, type Locator, type Page } from "@playwright/test";
import { createRoom, uniqueRoomId } from "./utils";

// Deleting a translation language another participant is working on: the
// guard (TranslationDeleteGuard, presence plugin) vetoes the removal and asks
// with a danger dialog naming the peers. "Working on" is the STICKY presence
// claim - the last locale whose cell the peer focused, held while they stay
// on the Translations tab - not just a live caret.

// One question whose title already carries a de translation, so the strings
// table renders default + de columns on both clients and the language list
// has a removable "Deutsch" row.
const DE_SCHEMA = {
    pages: [
        {
            name: "page1",
            elements: [{ type: "text", name: "question1", title: { default: "Q1 title", de: "Titel" } }]
        }
    ]
};

async function openRoomAs(page: Page, roomId: string, name: string): Promise<void> {
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

/** The "Deutsch" row of the sidebar language list. */
function germanRow(page: Page): Locator {
    return page
        .locator(".svc-side-bar [data-name='locales'] tr")
        .filter({ has: page.getByText("Deutsch", { exact: true }) });
}

/** Click the remove action on the Deutsch language row. */
async function removeGerman(page: Page): Promise<void> {
    const row = germanRow(page);
    await row.hover();
    await row.locator("button[title='Remove']").click();
}

/** The generic matrixdynamic confirmDelete popup (survey-core confirm). */
function genericConfirm(page: Page): Locator {
    return page
        .locator(".sv-popup")
        .filter({ hasText: "Are you certain you wish to delete all strings for this language?" })
        .filter({ visible: true });
}

/** The collab danger dialog raised by the guard. */
function dangerDialog(page: Page): Locator {
    return page.locator(".svc-creator-confirm-dialog").filter({ visible: true });
}

test.describe("translation delete guard", () => {
    // Wide viewport so #tab-translation is directly clickable (not collapsed
    // into the overflow menu by the collab bar).
    test.use({ viewport: { width: 1680, height: 1000 } });

    test("deleting a language a peer works on warns; cancel keeps it, confirm deletes for both", async ({ page, context }) => {
        const roomId = uniqueRoomId("tr-guard");
        await createRoom(page, roomId, DE_SCHEMA);

        const alice = page;
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await bob.setViewportSize({ width: 1680, height: 1000 });
        await openRoomAs(bob, roomId, "Bob");
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toBeVisible();

        await alice.locator("#tab-translation").click();
        await bob.locator("#tab-translation").click();

        const cellsA = alice.locator(".st-strings textarea");
        const cellsB = bob.locator(".st-strings textarea");
        await expect(cellsA).toHaveCount(2);
        await expect(cellsB).toHaveCount(2);

        // Bob works on German: he focuses the de cell, then leaves the cell
        // but STAYS on the tab - the sticky claim must survive the blur (a
        // live-caret-only criterion would fail from here on).
        await cellsB.nth(1).click();
        await cellsB.nth(1).blur();

        // Alice deletes the German row: first the generic confirm...
        await removeGerman(alice);
        await genericConfirm(alice).getByRole("button", { name: "OK" }).click();

        // ...then the guard's danger dialog, naming Bob and the language.
        const dialog = dangerDialog(alice);
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Bob");
        await expect(dialog).toContainText("Deutsch");

        // Cancel -> nothing deleted anywhere.
        await dialog.getByRole("button", { name: "Cancel" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(cellsA).toHaveCount(2);
        await expect(cellsB).toHaveCount(2);
        await expect(germanRow(alice)).toHaveCount(1);

        // Same flow, but this time Alice confirms -> the language and all its
        // strings disappear on BOTH clients.
        await removeGerman(alice);
        await genericConfirm(alice).getByRole("button", { name: "OK" }).click();
        await dangerDialog(alice).getByRole("button", { name: "Delete language" }).click();

        await expect(germanRow(alice)).toHaveCount(0);
        await expect(cellsA).toHaveCount(1);
        // Bob's side: the deletion arrives as per-string clear records, so his
        // de cell empties. His COLUMN staying rendered until the tab rebuilds
        // is the known partial-delete gap tracked as a separate task.
        await expect(cellsB.nth(1)).toHaveValue("");
    });

    test("no warning when the peer left the Translations tab (sticky claim released)", async ({ page, context }) => {
        const roomId = uniqueRoomId("tr-guard-neg");
        await createRoom(page, roomId, DE_SCHEMA);

        const alice = page;
        await openRoomAs(alice, roomId, "Alice");
        const bob = await context.newPage();
        await bob.setViewportSize({ width: 1680, height: 1000 });
        await openRoomAs(bob, roomId, "Bob");
        await expect(alice.locator('.svc-collab-bar__participant[title*="Bob"]')).toBeVisible();

        await alice.locator("#tab-translation").click();
        await bob.locator("#tab-translation").click();

        const cellsB = bob.locator(".st-strings textarea");
        await expect(cellsB).toHaveCount(2);
        await cellsB.nth(1).click();

        // Bob leaves the Translations tab - the tab switch releases his
        // sticky claim atomically.
        await bob.locator("#tab-designer").click();

        // Alice deletes German: only the generic confirm appears, never the
        // guard's danger dialog.
        await removeGerman(alice);
        await genericConfirm(alice).getByRole("button", { name: "OK" }).click();
        await expect(germanRow(alice)).toHaveCount(0);
        await expect(dangerDialog(alice)).toHaveCount(0);
    });
});
