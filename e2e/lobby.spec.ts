import { test, expect, type Page } from "@playwright/test";
import { uniqueRoomId } from "./utils";

/**
 * The lobby form is itself a SurveyJS survey rendered with survey-react-ui,
 * so the locators target SurveyJS question DOM (`[data-name=...]`).
 */
const roomInput = (page: Page) => page.locator("[data-name='roomId'] input");
const roomQuestion = (page: Page) => page.locator("[data-name='roomId']");
const seedQuestion = (page: Page) => page.locator("[data-name='seed']");
const seedTextarea = (page: Page) => page.locator("[data-name='seed'] textarea");
// SurveyJS radios are visually hidden inputs behind a decorator — click the label text.
const frameworkChoice = (page: Page, label: string) =>
    page.locator("[data-name='framework']").getByText(label, { exact: true });

test.describe("lobby", () => {
    test("empty room id: creates a random room with an empty survey", async ({ page }) => {
        await page.goto("/");
        await expect(roomQuestion(page)).toContainText("A random room with an empty survey will be created.");
        // Seed input hidden for the random-room flow.
        await expect(seedQuestion(page)).toBeHidden();

        await page.getByRole("button", { name: "Create & join" }).click();
        await page.waitForURL(/\/react\/\?room=[a-z0-9]+/);

        // The random room bootstraps as an empty survey (toolbox present, no questions).
        await expect(page.locator(".svc-toolbox__item").first()).toBeVisible();
        await expect(page.locator("[data-sv-drop-target-survey-element^=question]")).toHaveCount(0);
    });

    test("new room id: shows the seed textarea and creates the room with it", async ({ page }) => {
        const roomId = uniqueRoomId("lobby-new");
        await page.goto("/");
        await roomInput(page).fill(roomId);

        // Debounced existence check → room is new → seed form appears.
        await expect(roomQuestion(page)).toContainText("Room doesn't exist");
        await expect(seedQuestion(page)).toBeVisible();

        await seedTextarea(page).fill(JSON.stringify({
            title: "Lobby seeded",
            pages: [{ name: "p1", elements: [{ type: "text", name: "q_lobby", title: "Lobby question" }] }]
        }));
        // Pick a non-default framework to prove the choice is honored.
        await frameworkChoice(page, "JS").click();
        await page.getByRole("button", { name: "Create & join" }).click();

        await page.waitForURL(`**/js/?room=${roomId}`);
        await expect(page.getByText("Lobby question").first()).toBeVisible();
    });

    test("invalid seed JSON is rejected inline", async ({ page }) => {
        const roomId = uniqueRoomId("lobby-bad");
        await page.goto("/");
        await roomInput(page).fill(roomId);
        await expect(seedQuestion(page)).toBeVisible();
        await seedTextarea(page).fill("{ not json");
        await page.getByRole("button", { name: "Create & join" }).click();
        await expect(seedQuestion(page)).toContainText("Invalid JSON");
        await expect(page).toHaveURL("/"); // still in the lobby
    });

    test("?room= prefills the room id and triggers the existence check", async ({ page }) => {
        const existing = uniqueRoomId("lobby-pre");
        const res = await page.request.post("/api/rooms", { data: { roomId: existing, seed: {} } });
        expect(res.status()).toBe(201);

        // Existing room: prefilled, recognized, seed form hidden.
        await page.goto(`/?room=${existing}`);
        await expect(roomInput(page)).toHaveValue(existing);
        await expect(roomQuestion(page)).toContainText("Room exists");
        await expect(seedQuestion(page)).toBeHidden();

        // Unknown room: prefilled and offered for creation with a seed.
        const unknown = uniqueRoomId("lobby-pre-new");
        await page.goto(`/?room=${unknown}`);
        await expect(roomInput(page)).toHaveValue(unknown);
        await expect(roomQuestion(page)).toContainText("Room doesn't exist");
        await expect(seedQuestion(page)).toBeVisible();
    });

    test("Copy invite link copies a lobby URL with the room prefilled", async ({ page, context, baseURL }) => {
        const roomId = uniqueRoomId("invite");
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        const res = await page.request.post("/api/rooms", { data: { roomId, seed: {} } });
        expect(res.status()).toBe(201);

        await page.goto(`/react/?room=${roomId}`);
        // The button is labelled by its caption; "Copy invite link" is its
        // tooltip (survey-core actions expose no aria-label).
        await page.getByRole("button", { name: "Invite" }).click();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied).toBe(`${baseURL}/?room=${roomId}`);

        // The invite actually lands on the lobby with the room recognized.
        await page.goto(copied);
        await expect(roomInput(page)).toHaveValue(roomId);
        await expect(roomQuestion(page)).toContainText("Room exists");
    });

    test("browser Back from a client returns to a usable lobby form", async ({ page }) => {
        await page.goto("/");
        await expect(roomInput(page)).toBeVisible();

        // Complete the lobby → land in a client.
        await page.getByRole("button", { name: "Create & join" }).click();
        await page.waitForURL(/\/react\/\?room=[a-z0-9]+/);
        await expect(page.locator(".svc-toolbox__item").first()).toBeVisible();

        // Back must show the form again (not just the survey title), whether the
        // page is restored from the back-forward cache or fully reloaded.
        await page.goBack();
        await expect(roomInput(page)).toBeVisible();
        await expect(page.getByRole("button", { name: "Create & join" })).toBeVisible();
    });

    test("existing room id: seed form stays hidden and the button joins", async ({ page }) => {
        const roomId = uniqueRoomId("lobby-exist");
        const res = await page.request.post("/api/rooms", { data: { roomId, seed: {} } });
        expect(res.status()).toBe(201);

        await page.goto("/");
        await roomInput(page).fill(roomId);
        await expect(roomQuestion(page)).toContainText("Room exists");
        await expect(seedQuestion(page)).toBeHidden();

        await page.getByRole("button", { name: "Join", exact: true }).click();
        await page.waitForURL(`**/react/?room=${roomId}`);
    });
});
