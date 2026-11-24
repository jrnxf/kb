import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type Browser, type Page, chromium } from "playwright";
import { type Served, serve } from "../cli/serve.ts";
import type { Store } from "../cli/store.ts";
import { putNote, tempStore } from "./helpers.ts";

// The page's keys in a real browser, at desktop and phone width. A key that stops working
// shows no error anywhere, so only a browser finds it.

let browser: Browser;
// Chromium can take longer than the 5 s default to start and to close on a busy machine.
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
}, 30_000);

const LONG = Array.from({ length: 80 }, (_, i) => `Line ${i} of a long note.`).join("\n\n");

async function open(width: number): Promise<{ page: Page; store: Store; served: Served }> {
  const store = tempStore();
  for (const id of ["one", "two", "three"]) putNote(store, { id, title: `Note ${id}`, body: LONG });
  const served = serve(store, { port: 0 });
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  // Fail inside Bun's 5 s test timeout, so one broken key does not break the next test.
  page.setDefaultTimeout(3000);
  await page.goto(served.link);
  await page.getByRole("heading", { level: 1, name: "kb" }).waitFor();
  return { page, store, served };
}

/** The id of the selected note, from the address. */
async function selected(page: Page): Promise<string | null> {
  return new URLSearchParams((await page.evaluate(() => location.hash)).slice(1)).get("note");
}

/** Wait until the check passes, as the page answers a key after a render. */
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const end = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what}`);
    await Bun.sleep(25);
  }
}

describe("keys on a wide screen", () => {
  let page: Page, store: Store, served: Served;
  beforeEach(async () => {
    ({ page, store, served } = await open(1280));
  });
  afterEach(async () => {
    served.stop();
    await page.close();
  });

  test("a note an agent adds shows without a reload, and a trash from the page is not undone by the poll", async () => {
    putNote(store, { id: "four", title: "Note four" });
    await page.locator('[data-id="four"]').waitFor({ timeout: 8000 });
    await page.locator('[data-id="two"]').click();
    await page.keyboard.press("Backspace");
    await until(async () => (await page.locator('[data-id="two"]').count()) === 0, "the note leaves the list");
    // Two poll turns later the note is still gone, and nothing came back.
    await Bun.sleep(6500);
    expect(await page.locator('[data-id="two"]').count()).toBe(0);
    expect(await page.locator('[data-id="four"]').count()).toBe(1);
  }, 20000);

  test("j and k move through the list", async () => {
    const first = await selected(page);
    await page.keyboard.press("j");
    await until(async () => (await selected(page)) !== first, "the selection moves");
    await page.keyboard.press("k");
    await until(async () => (await selected(page)) === first, "the selection moves back");
  });

  test("e opens the form, and Backspace moves the note to the trash", async () => {
    await page.keyboard.press("e");
    await page.locator("main textarea").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("main textarea").waitFor({ state: "detached" });
    const id = (await selected(page))!;
    await page.keyboard.press("Backspace");
    await until(() => store.find(id)?.trashed ?? false, "the note is in the trash");
  });

  test("in the trash, Backspace asks first, then deletes the note for good, and Empty trash clears the rest", async () => {
    const [one, two] = await page.locator("button[data-id]").evaluateAll((rows) => rows.slice(0, 2).map((r) => r.getAttribute("data-id")!));
    for (const id of [one!, two!]) {
      await page.locator(`[data-id="${id}"]`).click();
      await page.keyboard.press("Backspace");
      await until(() => store.find(id)?.trashed ?? false, "the note is in the trash");
    }
    await page.locator('[data-rail="trash"]').click();
    await page.keyboard.press("ArrowRight");
    const id = (await selected(page))!;
    await page.keyboard.press("Backspace");
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Delete this note for good?").waitFor();
    // Escape keeps the note.
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(store.find(id)).toBeDefined();
    await page.keyboard.press("Backspace");
    await dialog.waitFor();
    // At once, before the dialog moves the focus to its button, as a quick hand does.
    await page.keyboard.press("Enter");
    await until(() => store.find(id) === undefined, "the note is deleted");
    await page.getByRole("button", { name: "Empty trash" }).click();
    await dialog.getByText("Empty the trash?").waitFor();
    await dialog.getByRole("button", { name: /Empty trash/ }).click();
    await until(() => store.notes({ trashed: true }).length === 0, "the trash is empty");
    await page.locator('[data-rail="trash"]').waitFor({ state: "detached" });
  });

  test("Trash project asks first, moves every note of the project, and ⌘Z brings it back", async () => {
    const web = "github.com/acme/web";
    for (const id of ["w1", "w2"]) putNote(store, { id, title: `Web ${id}`, scope: web });
    await page.reload();
    await page.locator(`[data-rail="scope:${web}"]`).click();
    await page.getByRole("button", { name: "Trash project" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("All 2 notes of acme/web go to the trash.", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: /Trash project/ }).click();
    await until(() => store.notes().every((n) => n.scope !== web), "the project is in the trash");
    // A project with no notes is gone from the sidebar. In the trash it shows while it has notes there.
    await page.locator(`[data-rail="scope:${web}"]`).waitFor({ state: "detached" });
    await page.locator('[data-rail="trash"]').click();
    await page.locator(`[data-rail="scope:${web}"]`).waitFor();
    await page.locator('[data-rail="trash"]').click();
    await page.locator(`[data-rail="scope:${web}"]`).waitFor({ state: "detached" });
    expect(store.notes().map((n) => n.id).sort()).toEqual(["one", "three", "two"]);
    await page.getByText("Moved the project to the trash", { exact: true }).waitFor();
    await page.keyboard.press("Meta+z");
    await until(() => store.notes().filter((n) => n.scope === web).length === 2, "the project is back");
    await until(async () => (await page.locator(`[data-rail="scope:${web}"]`).getAttribute("aria-pressed")) === "true", "the project is picked again");
  });

  test("Backspace on a project in the sidebar asks to trash the project, and not on global", async () => {
    putNote(store, { id: "w1", scope: "github.com/acme/web" });
    await page.reload();
    await page.locator('[data-rail="scope:global"]').click();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Backspace");
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Move this project to the trash?").waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(store.notes()).toHaveLength(4);
  });

  test("Undo selects the restored note, and no other row on the way", async () => {
    // The last row, so the row selected after the move is not the first row.
    const last = await page.locator("[data-id]").last().getAttribute("data-id");
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await until(async () => (await selected(page)) === last, "the last row is selected");
    const id = last!;
    await page.keyboard.press("Backspace");
    await until(() => store.find(id)?.trashed ?? false, "the note is in the trash");
    // The page takes Undo once its toast shows, as a person does. The file moves before that.
    await page.getByText("Moved to the trash", { exact: true }).waitFor();
    const before = (await selected(page))!;
    expect(await page.locator("[data-id]").first().getAttribute("data-id")).not.toBe(before);
    // Every row that is the current one at any moment, from here on.
    await page.evaluate(() => {
      const seen: string[] = ((window as unknown as { seen: string[] }).seen = []);
      new MutationObserver(() => {
        for (const row of document.querySelectorAll("[data-id][aria-current=true]")) seen.push(row.getAttribute("data-id")!);
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current"] });
    });
    await page.keyboard.press("Meta+z");
    await until(async () => (await selected(page)) === id, "the restored note is selected");
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(seen.filter((row) => row !== id && row !== before)).toEqual([]);
  });
});

describe("keys on a phone", () => {
  let page: Page, store: Store, served: Served;
  const drawer = () => page.locator("[data-note-drawer]");
  beforeEach(async () => {
    ({ page, store, served } = await open(390));
    await page.keyboard.press("Enter");
    await drawer().waitFor();
  });
  afterEach(async () => {
    served.stop();
    await page.close();
  });

  test("in the open drawer, e opens the form and Escape keeps the drawer", async () => {
    await page.keyboard.press("e");
    await drawer().locator("textarea").waitFor();
    await page.keyboard.press("Escape");
    await drawer().locator("textarea").waitFor({ state: "detached" });
    expect(await drawer().isVisible()).toBe(true);
  });

  test("in the open drawer, Backspace moves the note to the trash and closes the drawer", async () => {
    const id = (await selected(page))!;
    await page.keyboard.press("Backspace");
    await until(() => store.find(id)?.trashed ?? false, "the note is in the trash");
    await drawer().waitFor({ state: "detached" });
  });

  test("in the open drawer, space scrolls the note and j shows the next one", async () => {
    const scroller = drawer().locator(".overflow-y-auto");
    await page.keyboard.press(" ");
    await until(async () => (await scroller.evaluate((el) => el.scrollTop)) > 0, "the note scrolls");
    const first = await selected(page);
    await page.keyboard.press("j");
    await until(async () => (await selected(page)) !== first, "the selection moves");
    expect(await drawer().isVisible()).toBe(true);
  });

  test("Escape closes the drawer, and the list keys work again", async () => {
    await page.keyboard.press("Escape");
    await drawer().waitFor({ state: "detached" });
    const first = await selected(page);
    await page.keyboard.press("j");
    await until(async () => (await selected(page)) !== first, "the selection moves");
  });
});

describe("a page with data from an older kb serve", () => {
  test("a note with no list of triggers still opens", async () => {
    // A kb serve that started before the update serves the new page from disk, with the notes as the old code sends them.
    const store = tempStore();
    putNote(store, { id: "one", title: "Note one", body: "The body of one.", triggers: ["cmd: zorp --wipe"] });
    const served = serve(store, { port: 0 });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(3000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/page", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      for (const note of data.notes) delete note.triggers;
      await route.fulfill({ response, json: data });
    });
    try {
      await page.goto(served.link);
      await page.locator('[data-id="one"]').click();
      await page.getByText("The body of one.").waitFor();
      expect(await page.getByText("loads at").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      served.stop();
      await page.close();
    }
  });
});
