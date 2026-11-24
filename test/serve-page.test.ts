import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { serve } from "../cli/serve.ts";
import { Store } from "../cli/store.ts";
import { putNote, tempDir, tempStore } from "./helpers.ts";

// What the page says about the server in a real browser: down, read only, or empty.

let browser: Browser;
// Chromium can take longer than the 5 s default to start and to close on a busy machine.
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
}, 30_000);

describe("the page and its server", () => {
  test("a page opened without the key reads, and says how to get the key. The link's key is kept and leaves the address", async () => {
    const store = tempStore();
    putNote(store, { id: "a", title: "A note" });
    const served = serve(store, { port: 0 });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    try {
      await page.goto(served.url);
      await page.getByText("A note").first().waitFor();
      await page.getByText("Read only.").waitFor();
      expect(await page.getByRole("status").textContent()).toContain("open the link that kb serve printed");
      // The link puts the key in this browser and takes it out of the address.
      await page.goto(`${served.link}&note=a`);
      await page.getByText("A note").first().waitFor();
      expect(await page.evaluate(() => location.hash)).toBe("#note=a");
      await page.getByText("Read only.").waitFor({ state: "detached" });
      // A later visit without the key in the address still writes.
      await page.goto(served.url);
      await page.getByRole("button", { name: /^Trash/ }).click();
      await page.getByText("Moved to the trash").waitFor();
      expect(store.find("a")!.trashed).toBe(true);
    } finally {
      served.stop();
      await context.close();
    }
  });

  test("while the server is down the page says so, and after a restart a change works with no reload", async () => {
    const store = tempStore();
    putNote(store, { id: "a", title: "A note" });
    let served = serve(store, { port: 0 });
    const port = served.port;
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      await page.goto(served.link);
      await page.getByText("A note").first().waitFor();
      served.stop();
      await page.getByText("kb serve is not running.").waitFor();
      served = serve(store, { port });
      await page.getByText("kb serve is not running.").waitFor({ state: "detached" });
      await page.getByRole("button", { name: /^Trash/ }).click();
      await page.getByText("Moved to the trash").waitFor();
      expect(store.find("a")!.trashed).toBe(true);
    } finally {
      served.stop();
      await context.close();
    }
  }, 20_000);

  test("a store that does not exist yet shows what to do next", async () => {
    const served = serve(new Store(join(tempDir(), "none")), { port: 0 });
    const page = await browser.newPage();
    page.setDefaultTimeout(4000);
    try {
      await page.goto(served.link);
      await page.getByText("No notes yet.").waitFor();
      expect(await page.getByText("Run /kb:save in a Claude Code session").count()).toBe(1);
    } finally {
      served.stop();
      await page.close();
    }
  });
});
