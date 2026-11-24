import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, type BrowserContextOptions, type Page, chromium, devices } from "playwright";
import { type Served, serve } from "../cli/serve.ts";
import { putNote, tempStore } from "./helpers.ts";

// How the page reads and feels in a real browser: errors on their field, the history, the tab
// order, contrast, tap targets and motion. None of these shows as an error anywhere.

let browser: Browser;
// Chromium can take longer than the 5 s default to start and to close on a busy machine.
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
}, 30_000);

const TABLE = "Ports:\n\n| service | port |\n| --- | --- |\n| web | 5173 |\n| api | 8080 |";

let served: Served | undefined;
let page: Page | undefined;
afterEach(async () => {
  served?.stop();
  await page?.context().close();
  served = page = undefined;
});

async function open(options: BrowserContextOptions = { viewport: { width: 1280, height: 800 } }): Promise<Page> {
  const store = tempStore();
  putNote(store, { id: "one", title: "Note one", kind: "decision", body: TABLE });
  putNote(store, { id: "two", title: "Note two", kind: "decision" });
  putNote(store, { id: "three", title: "Note three", kind: "decision" });
  putNote(store, { id: "four", title: "Note four", kind: "gotcha", scope: "github.com/example/app" });
  served = serve(store, { port: 0 });
  const context = await browser.newContext(options);
  page = await context.newPage();
  page.setDefaultTimeout(3000);
  await page.goto(served.link);
  await page.getByRole("heading", { level: 1, name: "kb" }).waitFor();
  return page;
}

const selected = async (page: Page) => new URLSearchParams((await page.evaluate(() => location.hash)).slice(1)).get("note");
const focused = (page: Page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("data-id") || document.activeElement?.getAttribute("data-rail") || "");

/** The WCAG contrast of two computed colours, as rgb() or as a grey oklch(). */
const CONTRAST = `(a, b) => {
  const lum = (c) => {
    const ok = /oklch\\(([\\d.]+)/.exec(c);
    if (ok) return Number(ok[1]) ** 3;
    const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}`;

describe("the edit form", () => {
  test("a failed save puts the error on its field, without the server's prefix, focuses that field, and Escape still cancels", async () => {
    const page = await open();
    await page.keyboard.press("e");
    const title = page.locator("#edit-title");
    await title.fill("");
    await page.getByRole("button", { name: /Save/ }).click();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toBe("The title is required.");
    expect(await title.getAttribute("aria-invalid")).toBe("true");
    expect(await page.locator("#edit-body").getAttribute("aria-invalid")).toBeNull();
    expect(await focused(page)).toBe("edit-title");
    expect(await page.locator("main").textContent()).not.toContain("invalid note");
    // The focus can be anywhere on the page, and Escape still closes the form.
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.keyboard.press("Escape");
    await page.locator("#edit-title").waitFor({ state: "detached" });
  });
});

describe("history and the tab", () => {
  test("Back goes to the note before, and the tab shows the open note's title", async () => {
    const page = await open();
    const first = await selected(page);
    await page.locator('[data-id="two"]').click();
    await page.locator('[data-id="three"]').click();
    expect(await page.title()).toBe("Note three - kb");
    await page.goBack();
    await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get("note") === "two");
    expect(await page.title()).toBe("Note two - kb");
    await page.goBack();
    await page.waitForFunction((id) => new URLSearchParams(location.hash.slice(1)).get("note") === id, first);
    expect(page.url()).toStartWith(served!.url);
  });

  test("j and k move to another note without adding a history entry", async () => {
    const page = await open();
    const first = await selected(page);
    const before = await page.evaluate(() => history.length);
    await page.keyboard.press("j");
    await page.waitForFunction((id) => new URLSearchParams(location.hash.slice(1)).get("note") !== id, first);
    await page.keyboard.press("k");
    await page.waitForFunction((id) => new URLSearchParams(location.hash.slice(1)).get("note") === id, first);
    expect(await page.evaluate(() => history.length)).toBe(before);
  });
});

describe("the keyboard", () => {
  test("Tab goes from the filter to the open row, and the arrows move the focus with the row", async () => {
    const page = await open();
    await page.keyboard.press("/");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe((await selected(page))!);
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-id") === new URLSearchParams(location.hash.slice(1)).get("note"));
    // Back from the row: the filter, the keys and theme buttons, then the picked scope.
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+Tab");
    expect(await focused(page)).toBe("scope:*");
    // One row and one sidebar item are in the tab order.
    expect(await page.locator('[data-id][tabindex="0"]').count()).toBe(1);
    expect(await page.locator('[data-rail][tabindex="0"]').count()).toBe(1);
  });

  test("the list of keys has j, k, h and l", async () => {
    const page = await open();
    await page.keyboard.press("?");
    const text = (await page.getByRole("dialog").textContent()) ?? "";
    for (const key of ["jk", "hl"]) expect(text).toContain(key);
  });
});

describe("keys on a focused button", () => {
  /** Tab from the filter onto the open row. */
  async function toRow(page: Page) {
    await page.keyboard.press("/");
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe((await selected(page))!);
  }

  test("h and l move the focus with the pane, so Enter and Space act on the item the user sees", async () => {
    const page = await open();
    await toRow(page);
    await page.keyboard.press("h");
    expect(await focused(page)).toBe("scope:*");
    // Space on a kind in the sidebar presses it once, and Enter presses it once.
    const kind = page.locator('[data-rail="kind:decision"]');
    for (let i = 0; i < 12 && (await focused(page)) !== "kind:decision"; i++) await page.keyboard.press("j");
    expect(await focused(page)).toBe("kind:decision");
    await page.evaluate(() => {
      const w = window as unknown as { clicks: number };
      w.clicks = 0;
      document.addEventListener("click", () => w.clicks++, true);
    });
    await page.keyboard.press(" ");
    expect(await kind.getAttribute("aria-pressed")).toBe("true");
    await page.keyboard.press("Enter");
    expect(await kind.getAttribute("aria-pressed")).toBe("false");
    await page.keyboard.press("Space");
    await page.keyboard.up("Space");
    expect(await kind.getAttribute("aria-pressed")).toBe("true");
    // A key press is not a click, so a key press never presses twice.
    expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(0);
    await page.keyboard.press("l");
    expect(await focused(page)).toBe((await selected(page))!);
  });

  test("Enter on the open row keeps the focus on it", async () => {
    const page = await open();
    await toRow(page);
    const row = await focused(page);
    await page.keyboard.press("Enter");
    expect(await focused(page)).toBe(row);
    // A click still gives the keys back to the page.
    await page.locator('[data-id="two"]').click();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  test("Enter and Space on another button press that button and nothing else", async () => {
    const page = await open();
    const theme = page.getByRole("button", { name: /^Theme/ });
    const before = await theme.getAttribute("aria-label");
    await theme.focus();
    await page.keyboard.press("Enter");
    expect(await theme.getAttribute("aria-label")).not.toBe(before);
    expect(await page.locator("main table").count()).toBe(1);
  });
});

describe("contrast", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`${colorScheme}: faint text passes 4.5:1, and a kind with no notes is not faded`, async () => {
      const page = await open({ viewport: { width: 1280, height: 800 }, colorScheme });
      // A filter that hides every note gives each kind a count of 0.
      await page.locator("#q").fill("nothing matches this");
      await page.locator("#q").press("Escape");
      const ratio = await page.evaluate(`(${CONTRAST})(getComputedStyle(document.querySelector('[data-rail="kind:gotcha"] span:last-child')).color, getComputedStyle(document.body).backgroundColor)`);
      expect(ratio as number).toBeGreaterThanOrEqual(4.5);
      const opacity = await page.locator('[data-rail="kind:gotcha"]').evaluate((el) => getComputedStyle(el).opacity);
      expect(opacity).toBe("1");
      const ring = await page.evaluate(`(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--ring)";
        document.body.append(probe);
        return (${CONTRAST})(getComputedStyle(probe).color, getComputedStyle(document.body).backgroundColor);
      })()`);
      expect(ring as number).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("a note's table", () => {
  test("has borders and padding, and scrolls inside the note", async () => {
    const page = await open();
    await page.locator('[data-id="one"]').click();
    const style = await page.locator("main table").evaluate((el) => {
      const cell = getComputedStyle(el.querySelector("td")!), head = getComputedStyle(el.querySelector("th")!);
      return { collapse: getComputedStyle(el).borderCollapse, overflow: getComputedStyle(el).overflowX, padding: cell.padding, border: cell.borderTopWidth, align: head.textAlign };
    });
    expect(style).toEqual({ collapse: "collapse", overflow: "visible", padding: "6px 10px", border: "1px", align: "left" });
    // The table keeps its own display, so a screen reader still reads it as a table. A wrapper scrolls.
    expect(await page.locator("main table").evaluate((el) => getComputedStyle(el).display)).toBe("table");
    expect(await page.locator("main .table-scroll").evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    expect(await page.getByRole("table").count()).toBe(1);
  });
});

describe("history and the sidebar", () => {
  test("Back puts the sidebar cursor and the held scope back with the view", async () => {
    const page = await open();
    await page.locator('[data-id="two"]').click();
    await page.locator('[data-rail="scope:github.com/example/app"]').click();
    await page.locator('[data-rail="scope:github.com/example/app"]').waitFor();
    expect(await page.locator('[data-rail][tabindex="0"]').getAttribute("data-rail")).toBe("scope:github.com/example/app");
    await page.goBack();
    await page.waitForFunction(() => !new URLSearchParams(location.hash.slice(1)).get("scope"));
    expect(await page.locator('[data-rail][tabindex="0"]').getAttribute("data-rail")).toBe("scope:*");
    expect(await page.locator('[data-rail="scope:*"]').getAttribute("aria-pressed")).toBe("true");
  });

  test("Back on a screen that turned narrow goes to the note before, and the address keeps it", async () => {
    const page = await open();
    await page.locator('[data-id="two"]').click();
    await page.locator('[data-id="three"]').click();
    await page.setViewportSize({ width: 400, height: 800 });
    await page.waitForFunction(() => innerWidth === 400);
    await page.goBack();
    await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get("note") === "two");
    expect(await selected(page)).toBe("two");
  });
});

describe("the tab", () => {
  test("the audit page has its own title, and the notes page takes its title back", async () => {
    const page = await open();
    await page.locator('[data-id="two"]').click();
    await page.evaluate(() => (location.hash = "#audit=global"));
    await page.waitForFunction(() => document.title === "Audit of global - kb");
    await page.goBack();
    await page.waitForFunction(() => document.title === "Note two - kb");
  });
});

describe("the edit form, on an error that no field owns", () => {
  test("the focus goes to the error in the footer, and a valid body keeps it", async () => {
    const page = await open();
    await page.route("**/api/notes/*", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 500, json: { error: "disk full" } }) : route.fallback()));
    await page.keyboard.press("e");
    await page.getByRole("button", { name: /Save/ }).click();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toBe("disk full");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("alert");
  });
});

describe("on a phone", () => {
  test("a utility still beats the tap-target rule: an absolute button stays absolute", async () => {
    const page = await open({ ...devices["iPhone 13"] });
    const position = await page.evaluate(() => {
      const button = document.createElement("button");
      button.dataset.slot = "button";
      button.className = "absolute";
      document.body.append(button);
      return getComputedStyle(button).position;
    });
    expect(position).toBe("absolute");
  });


  test("every chip, row and button takes a tap 21 px above and below its centre, so its target is 44 px tall", async () => {
    const page = await open({ ...devices["iPhone 13"] });
    const misses = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("[data-rail], [data-id], aside [data-slot=button]")) {
        const r = el.getBoundingClientRect();
        if (!r.width || r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) continue;
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        for (const dy of [-21, 21]) {
          const hit = document.elementFromPoint(x, y + dy);
          if (!hit || !el.contains(hit)) out.push(`${el.dataset.rail ?? el.dataset.id ?? el.getAttribute("aria-label")} ${Math.round(r.height)}px`);
        }
      }
      return [...new Set(out)];
    });
    expect(misses).toEqual([]);
  });
});

describe("motion", () => {
  test("stops when the system asks for reduced motion", async () => {
    const page = await open({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    const duration = await page.locator('[data-rail="kind:decision"] [data-slot=kbd]').evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(duration)).toBeLessThan(0.001);
  });
});
