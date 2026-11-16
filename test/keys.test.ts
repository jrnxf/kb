import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type Browser, type Page, chromium } from "playwright";
import { type Served, serve } from "../cli/serve.ts";
import type { Store } from "../cli/store.ts";
import { putNote, tempStore } from "./helpers.ts";

// The page's keys in a real browser, at desktop and phone width. A key that stops working
// shows no error anywhere, so only a browser finds it.

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const LONG = Array.from({ length: 80 }, (_, i) => `Line ${i} of a long note.`).join("\n\n");

async function open(width: number): Promise<{ page: Page; store: Store; served: Served }> {
  const store = tempStore();
  for (const id of ["one", "two", "three"]) putNote(store, { id, title: `Note ${id}`, body: LONG });
  const served = serve(store, { port: 0 });
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  // Fail inside Bun's 5 s test timeout, so one broken key does not break the next test.
  page.setDefaultTimeout(3000);
  await page.goto(served.url);
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

  test("j and k move through the list", async () => {
    const first = await selected(page);
    await page.keyboard.press("j");
    await until(async () => (await selected(page)) !== first, "the selection moves");
    await page.keyboard.press("k");
    await until(async () => (await selected(page)) === first, "the selection moves back");
  });

  test("e opens the form, and a archives the note", async () => {
    await page.keyboard.press("e");
    await page.locator("main textarea").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("main textarea").waitFor({ state: "detached" });
    const id = (await selected(page))!;
    await page.keyboard.press("a");
    await until(() => store.find(id)?.archived ?? false, "the note is archived");
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

  test("in the open drawer, a archives the note and closes the drawer", async () => {
    const id = (await selected(page))!;
    await page.keyboard.press("a");
    await until(() => store.find(id)?.archived ?? false, "the note is archived");
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
