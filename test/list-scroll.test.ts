import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, type Locator, type Page, chromium } from "playwright";
import { serve } from "../cli/serve.ts";
import { putNote, tempStore } from "./helpers.ts";

// On a wide screen the note list scrolls under a fade at its edges. A row the keys move to must stop
// clear of the fade, or the selected note sits half hidden, and no error says so.

const FADE = 32;

/** How far an item stays inside a scroll area's visible edges, once the scroll has stopped. */
async function clearOf(page: Page, item: string, viewport: Locator) {
  let last = -1;
  for (let top = await viewport.evaluate((el) => el.scrollTop); top !== last; top = await viewport.evaluate((el) => el.scrollTop)) {
    last = top;
    await page.waitForTimeout(50);
  }
  const row = (await page.locator(item).boundingBox())!;
  const box = (await viewport.boundingBox())!;
  return { top: row.y - box.y, bottom: box.y + box.height - (row.y + row.height) };
}

/** Wait until the value passes the check, as the page answers after a render or a resize. */
async function until<T>(value: () => Promise<T>, check: (v: T) => boolean, what: string): Promise<void> {
  const end = Date.now() + 3000;
  let v = await value();
  while (!check(v)) {
    if (Date.now() > end) throw new Error(`timed out waiting until ${what} (last value ${String(v)})`);
    await Bun.sleep(25);
    v = await value();
  }
}

let browser: Browser;
// Chromium can take more than 5 s to start on a busy machine.
beforeAll(async () => {
  browser = await chromium.launch();
}, 20_000);
afterAll(async () => {
  await browser?.close();
});

test("the keys keep the selected row clear of the list's edge fade, and the filter stays put", async () => {
  const store = tempStore();
  const ids = Array.from({ length: 40 }, (_, i) => `note-${String(i).padStart(2, "0")}`);
  for (const id of ids) putNote(store, { id, title: `Note ${id}`, body: "body" });
  const served = serve(store, { port: 0 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });
  page.setDefaultTimeout(3000);
  try {
    await page.goto(served.url);
    await page.getByRole("heading", { level: 1, name: "kb" }).waitFor();
    const viewport = page.locator("[data-slot=scroll-area-viewport]:has([data-id])");
    const filter = page.locator("#q");
    const filterTop = (await filter.boundingBox())!.y;

    const clearance = () => clearOf(page, "[data-id][aria-current=true]", viewport);

    for (let i = 0; i < 25; i++) await page.keyboard.press("j");
    await page.locator(`[data-id="${ids[25]}"][aria-current=true]`).waitFor();
    expect((await clearance()).bottom).toBeGreaterThanOrEqual(FADE - 1);
    expect(await viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    for (let i = 0; i < 15; i++) await page.keyboard.press("k");
    await page.locator(`[data-id="${ids[10]}"][aria-current=true]`).waitFor();
    expect((await clearance()).top).toBeGreaterThanOrEqual(FADE - 1);

    // The filter sits above the scroll area, so it does not move as the list scrolls.
    expect((await filter.boundingBox())!.y).toBe(filterTop);
  } finally {
    served.stop();
    await page.close();
  }
});

test("the bottom fade follows a filter that shortens the list, and comes back when it is cleared", async () => {
  const store = tempStore();
  for (let i = 0; i < 40; i++) putNote(store, { id: `note-${i}`, title: i < 3 ? `Rare ${i}` : `Common ${i}`, body: "body" });
  const served = serve(store, { port: 0 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });
  page.setDefaultTimeout(3000);
  try {
    await page.goto(served.url);
    await page.getByRole("heading", { level: 1, name: "kb" }).waitFor();
    const viewport = page.locator("[data-slot=scroll-area-viewport]:has([data-id])");
    // Base UI keeps how far the area can still scroll down in this variable, and the fade reads it.
    const below = async () => parseFloat(await viewport.evaluate((el) => el.style.getPropertyValue("--scroll-area-overflow-y-end")) || "0");
    await until(below, (v) => v > 0, "the list can scroll down");
    // No scroll event follows a filter, so only the content's own size tells Base UI that nothing is below.
    await page.locator("#q").fill("Rare");
    await until(() => page.locator("[data-id]").count(), (n) => n > 0 && n < 10, "the filter leaves a few rows");
    await until(below, (v) => v === 0, "nothing is below the rows");
    await page.locator("#q").fill("");
    await until(below, (v) => v > 0, "the list can scroll down again");
  } finally {
    served.stop();
    await page.close();
  }
});

test("on a phone the rows fade under the filter only while it is stuck to the top", async () => {
  const store = tempStore();
  for (let i = 0; i < 40; i++) putNote(store, { id: `note-${i}`, title: `Note ${i}`, body: "body" });
  const served = serve(store, { port: 0 });
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  page.setDefaultTimeout(3000);
  try {
    await page.goto(served.url);
    await page.getByRole("heading", { level: 1, name: "kb" }).waitFor();
    const header = page.locator("div:has(> [data-slot=input-group]:has(#q))");
    const fade = () => header.evaluate((el) => getComputedStyle(el, "::after").opacity);
    const filterTop = async () => (await page.locator("#q").boundingBox())!.y;
    await until(fade, (v) => v === "0", "the fade is hidden at rest");
    // A short scroll moves the filter up, but it is not stuck yet, so nothing covers the first row.
    await page.evaluate(() => window.scrollTo(0, 30));
    expect(await filterTop()).toBeGreaterThan(30);
    await page.waitForTimeout(300);
    expect(await fade()).toBe("0");
    await page.evaluate(() => window.scrollTo(0, 2000));
    await until(fade, (v) => v === "1", "the fade shows under the stuck filter");
  } finally {
    served.stop();
    await page.close();
  }
});

test("in a short window the keys keep the rail's cursor clear of the rail's edge fade", async () => {
  const store = tempStore();
  // Many scopes, so the rail is taller than a short window.
  for (let i = 0; i < 20; i++) putNote(store, { id: `note-${i}`, title: `Note ${i}`, body: "body", scope: `github.com/example/repo-${String(i).padStart(2, "0")}` });
  const served = serve(store, { port: 0 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
  page.setDefaultTimeout(3000);
  try {
    await page.goto(served.url);
    await page.getByRole("heading", { level: 1, name: "kb" }).waitFor();
    const viewport = page.locator("[data-slot=scroll-area-viewport]:has([data-rail])");
    await page.keyboard.press("h");
    for (let i = 0; i < 15; i++) await page.keyboard.press("j");
    const cursor = "[data-rail].group-data-\\[pane\\=rail\\]\\/page\\:ring-1";
    await page.locator(cursor).waitFor();
    expect(await viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect((await clearOf(page, cursor, viewport)).bottom).toBeGreaterThanOrEqual(FADE - 1);
  } finally {
    served.stop();
    await page.close();
  }
});
