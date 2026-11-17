import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium } from "playwright";
import { serve } from "../cli/serve.ts";
import { putNote, tempStore } from "./helpers.ts";

// On a wide screen the note list scrolls under a fade at its edges. A row the keys move to must stop
// clear of the fade, or the selected note sits half hidden, and no error says so.

const FADE = 32;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
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

    /** How far the selected row stays inside the list's visible edges, after the smooth part of a scroll. */
    const clearance = async () => {
      await page.waitForTimeout(100);
      const row = (await page.locator("[data-id][aria-current=true]").boundingBox())!;
      const box = (await viewport.boundingBox())!;
      return { top: row.y - box.y, bottom: box.y + box.height - (row.y + row.height) };
    };

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
