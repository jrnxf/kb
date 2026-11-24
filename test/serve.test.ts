import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { type Served, pagePolicy, serve } from "../cli/serve.ts";
import type { Store } from "../cli/store.ts";
import { MAIN, daysAgo, kb, plain, putNote, sh, tempDir, tempStore, watchPolicy } from "./helpers.ts";

describe("kb serve", () => {
  let served: Served | undefined;
  afterEach(() => served?.stop());

  function start(store: Store): { call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }> } {
    served = serve(store, { port: 0 });
    const { url, token } = served;
    return {
      async call(method, path, body, headers = { "x-kb-token": token }) {
        const response = await fetch(new URL(path, url), { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, json: await response.json().catch(() => undefined) };
      },
    };
  }

  test("serves the built page, and the current notes on every load", async () => {
    const store = tempStore();
    putNote(store, { id: "a", title: "First note" });
    const { call } = start(store);
    const page = await fetch(served!.url);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain('<div id="root">');
    // Every script and style of the page comes from the server itself.
    for (const [, src] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      expect(src!.startsWith("/assets/")).toBe(true);
      const asset = await fetch(new URL(src!, served!.url));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toContain("immutable");
    }
    expect((await call("GET", "/api/page")).json.notes.map((n: { title: string }) => n.title)).toEqual(["First note"]);
    putNote(store, { id: "b", title: "Added while the server runs" });
    expect((await call("GET", "/api/page")).json.notes.map((n: { title: string }) => n.title)).toContain("Added while the server runs");
  });

  test("every answer forbids framing, sniffing and the referrer, and the page runs only its own script", async () => {
    start(tempStore());
    for (const path of ["/", "/api/page", "/api/state", "/assets/none.js", "/api/notes/none"]) {
      const response = await fetch(new URL(path, served!.url));
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
    const page = await fetch(served!.url);
    const policy = page.headers.get("content-security-policy")!;
    expect(policy).toStartWith("default-src 'none'");
    expect(policy).toContain("style-src 'self';");
    expect(policy).not.toContain("unsafe");
    // The inline theme script runs by its hash (the browser test below shows it runs).
    expect(policy).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*';/);
    expect(pagePolicy("<p>no script</p>")).toContain("script-src 'self';");
    // The browser hashes the text with CRLF read as LF, reads attributes as a parser does, and skips a script with a src.
    const hash = (text: string) => `'sha256-${new Bun.CryptoHasher("sha256").update(text).digest("base64")}'`;
    expect(pagePolicy("<script>a\r\nb</script>")).toContain(hash("a\nb"));
    expect(pagePolicy('<script nonce="x">c</script><script type="module" src="/a.js"></script>')).toContain(`script-src 'self' ${hash("c")};`);
    expect(pagePolicy('<script data-src="x">d</script>')).toContain(`script-src 'self' ${hash("d")};`);
    expect(pagePolicy('<script data-note="a>b">e</script>')).toContain(`script-src 'self' ${hash("e")};`);
    // A wrong host gets the headers too.
    expect((await fetch(new URL("/api/state", served!.url), { headers: { host: "evil.example.com" } })).headers.get("x-frame-options")).toBe("DENY");
  });

  test("a note's script link does nothing in a browser, and the page calls no other site", async () => {
    const store = tempStore();
    putNote(store, { id: "xss", title: "Links", body: "[plain](javascript:alert(1))\n\n[mixed](JaVaScRiPt:alert(1))\n\n[entity](&#106;avascript:alert(1))\n\n[web](https://example.com)\n\n![pixel](https://tracker.example.com/p.png)" });
    start(store);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      const blocked = await watchPolicy(page);
      const policy = (await fetch(served!.url)).headers.get("content-security-policy")!;
      const dialogs: string[] = [];
      const elsewhere: string[] = [];
      page.on("dialog", (dialog) => void (dialogs.push(dialog.message()), dialog.dismiss()));
      page.on("request", (request) => void (request.url().startsWith(served!.url) || elsewhere.push(request.url())));
      await page.goto(`${served!.url}#note=xss`);
      // The header holds the hash of the inline script as the browser reads it, so the script runs by that hash.
      const hashed = await page.evaluate(async () => {
        const text = document.querySelector("script:not([src])")!.textContent!;
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
        return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
      });
      expect(policy).toContain(`script-src 'self' ${hashed};`);
      const body = page.locator(".prose-kb");
      await body.getByText("entity").waitFor();
      for (const name of ["plain", "mixed", "entity"]) await body.getByText(name).click();
      expect(await body.locator("a").evaluateAll((links) => links.map((a) => a.getAttribute("href")))).toEqual(["https://example.com"]);
      expect(await body.textContent()).toContain("pixel");
      expect(dialogs).toEqual([]);
      expect(elsewhere).toEqual([]);
      expect(await blocked()).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 20_000);

  test("serves no file from outside the built page, and no other path", async () => {
    start(tempStore());
    // fetch() resolves "/../" itself, so hide the slash, as an attacker can.
    for (const path of ["/..%2fpackage.json", "/assets/..%2f..%2f..%2fcli%2fserve.ts", "/index.html", "/notes/a"]) {
      expect((await fetch(new URL(path, served!.url))).status).toBe(404);
    }
  });

  test("an edit changes the note, counts as a verification and is committed", async () => {
    const store = tempStore();
    sh(store.home, "git", "init", "-q", "-b", "main");
    putNote(store, { id: "a", title: "Old title", body: "old", anchors: ["src/a.ts"], triggers: ["cmd: zorp --wipe", "err: flux capacitor underflow"] });
    const { call } = start(store);
    // The page shows the triggers, and its edit form has no field for them.
    expect((await call("GET", "/api/page")).json.notes[0].triggers).toEqual(["cmd: zorp --wipe", "err: flux capacitor underflow"]);
    const saved = await call("PUT", "/api/notes/a", { title: "New title", kind: "decision", confidence: "high", body: "new body", scope: "other", id: "evil", created: "1999-01-01T00:00:00Z", triggers: ["cmd: other"] });
    expect(saved.status).toBe(200);
    const note = store.find("a")!;
    // An edit in the page never drops or changes the triggers and the anchors: only the CLI writes them.
    expect(note).toMatchObject({ id: "a", title: "New title", kind: "decision", confidence: "high", body: "new body", scope: "global", created: "2026-01-01T00:00:00Z", anchors: ["src/a.ts"], triggers: ["cmd: zorp --wipe", "err: flux capacitor underflow"] });
    expect(note.last_verified > "2026-01-01T00:00:00Z").toBe(true);
    expect(store.find("evil")).toBeUndefined();
    expect(sh(store.home, "git", "log", "-1", "--format=%s")).toBe("kb: update a");
    expect((await call("GET", "/api/notes/a")).json).toMatchObject({ title: "New title", body: "new body" });
  });

  test("a bad edit is refused with the reason and changes nothing", async () => {
    const store = tempStore();
    putNote(store, { id: "a", body: "kept" });
    const { call } = start(store);
    const bad = await call("PUT", "/api/notes/a", { kind: "nonsense", body: "" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("kind");
    expect(store.find("a")!.body).toBe("kept");
    expect((await call("PUT", "/api/notes/ghost", { body: "x" })).status).toBe(400);
  });

  test("trash and restore move the note and keep it", async () => {
    const store = tempStore();
    const note = putNote(store, { id: "a" });
    const { call } = start(store);
    expect((await call("POST", "/api/notes/a/trash")).status).toBe(200);
    expect(store.notes()).toHaveLength(0);
    const [trashed] = store.notes({ trashed: true });
    expect(trashed!.body).toBe(note.body);
    // The time is kept: the trash lists the newest first, and deletes a note 30 days after it.
    expect(Date.now() - Date.parse(trashed!.trashed_at!)).toBeLessThan(60_000);
    expect((await call("POST", "/api/notes/a/trash")).status).toBe(400);
    expect((await call("POST", "/api/notes/a/restore")).status).toBe(200);
    expect(store.notes().map((n) => n.id)).toEqual(["a"]);
    expect(store.find("a")!.trashed_at).toBeUndefined();
  });

  test("delete removes one note for good, and empty removes the whole trash", async () => {
    const store = tempStore();
    putNote(store, { id: "a", trashed_at: daysAgo(1) }, true);
    putNote(store, { id: "b", trashed_at: daysAgo(1) }, true);
    putNote(store, { id: "live" });
    const { call } = start(store);
    expect((await call("DELETE", "/api/notes/a")).json).toEqual({ deleted: ["a"] });
    expect(store.find("a")).toBeUndefined();
    expect((await call("POST", "/api/trash/empty")).json).toEqual({ deleted: ["b"] });
    expect(store.notes({ trashed: true })).toEqual([]);
    expect(store.notes().map((n) => n.id)).toEqual(["live"]);
    expect((await call("POST", "/api/trash/empty", undefined, {})).status).toBe(403);
    expect((await call("DELETE", "/api/notes/live", undefined, {})).status).toBe(403);
    // The page deletes only from the trash.
    expect((await call("DELETE", "/api/notes/live")).status).toBe(400);
    expect(store.find("live")).toBeDefined();
  });

  test("a project goes to the trash whole and comes back whole, and its trash empties alone", async () => {
    const store = tempStore();
    const web = "github.com/acme/web";
    putNote(store, { id: "a", scope: web });
    putNote(store, { id: "b", scope: web });
    putNote(store, { id: "api-old", scope: "github.com/acme/api", trashed_at: daysAgo(1) }, true);
    const { call } = start(store);
    expect((await call("POST", "/api/projects/trash", { scope: web })).json).toEqual({ scope: web, trashed: ["a", "b"] });
    expect(store.notes()).toEqual([]);
    expect((await call("POST", "/api/projects/trash", { scope: "global" })).status).toBe(400);
    expect((await call("POST", "/api/projects/trash", { scope: web }, {})).status).toBe(403);
    expect((await call("POST", "/api/projects/restore", { scope: web })).json).toEqual({ scope: web, restored: ["a", "b"] });
    await call("POST", "/api/projects/trash", { scope: web });
    expect((await call("POST", "/api/trash/empty", { scope: web })).json.deleted.sort()).toEqual(["a", "b"]);
    expect(store.notes({ trashed: true }).map((n) => n.id)).toEqual(["api-old"]);
  });

  test("a server that starts clears the notes whose time in the trash is up", () => {
    const store = tempStore();
    putNote(store, { id: "expired", trashed_at: daysAgo(31) }, true);
    putNote(store, { id: "recent", trashed_at: daysAgo(2) }, true);
    start(store);
    expect(store.notes({ trashed: true }).map((n) => n.id)).toEqual(["recent"]);
  });

  test("a change without the page's token, or under another host name, is refused", async () => {
    const store = tempStore();
    putNote(store, { id: "a", body: "kept" });
    const { call } = start(store);
    expect((await call("POST", "/api/notes/a/trash", undefined, {})).status).toBe(403);
    expect((await call("PUT", "/api/notes/a", { body: "x" }, { "x-kb-token": "guess" })).status).toBe(403);
    // A site that points its own name at this machine sends its own Host header.
    expect((await call("GET", "/", undefined, { host: "evil.example.com" })).status).toBe(403);
    expect((await call("POST", "/api/notes/a/trash", undefined, { host: "evil.example.com", "x-kb-token": served!.token })).status).toBe(403);
    expect(store.find("a")).toMatchObject({ trashed: false, body: "kept" });
  });

  test("a name in KB_SERVE_HOSTS is accepted, so a reverse proxy can sit in front", async () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    const { call } = start(store);
    process.env.KB_SERVE_HOSTS = "kb.example.com, other.example.com";
    try {
      expect((await call("GET", "/api/state", undefined, { host: "kb.example.com" })).status).toBe(200);
      expect((await call("GET", "/api/state", undefined, { host: "evil.example.com" })).status).toBe(403);
    } finally {
      delete process.env.KB_SERVE_HOSTS;
    }
  });

  test("a KB_SERVE_HOSTS name with a leading dot takes that domain and every name under it", async () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    const { call } = start(store);
    process.env.KB_SERVE_HOSTS = ".proxy.example.com";
    try {
      for (const host of ["4810.proxy.example.com", "a.b.proxy.example.com", "proxy.example.com", "4810.Proxy.Example.com:443"]) {
        expect((await call("GET", "/api/state", undefined, { host })).status).toBe(200);
      }
      // A name that only ends in the same letters is another domain.
      for (const host of ["evilproxy.example.com", "proxy.example.com.evil.com", "example.com"]) {
        expect((await call("GET", "/api/state", undefined, { host })).status).toBe(403);
      }
    } finally {
      delete process.env.KB_SERVE_HOSTS;
    }
  });

  test("the version changes when a note changes, so an open page reloads", async () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    const { call } = start(store);
    const before = (await call("GET", "/api/state")).json.version;
    expect((await call("GET", "/api/state")).json.version).toBe(before);
    putNote(store, { id: "b" });
    expect((await call("GET", "/api/state")).json.version).not.toBe(before);
  });

  test("the command starts a server, and a second one points at the first", async () => {
    const store = tempStore();
    putNote(store, { id: "a", title: "Served by the command" });
    const first = Bun.spawn([process.execPath, MAIN, "serve", "--port", "0", "--json"], { cwd: plain(), env: { ...process.env, KB_HOME: store.home }, stdout: "pipe", stderr: "pipe" });
    try {
      let text = "";
      const reader = first.stdout.getReader();
      while (!text.includes("}")) text += new TextDecoder().decode((await reader.read()).value);
      const { url, started } = JSON.parse(text);
      expect(started).toBe(true);
      const page = (await (await fetch(new URL("/api/page", url))).json()) as { notes: { title: string }[] };
      expect(page.notes.map((n) => n.title)).toEqual(["Served by the command"]);
      const second = kb(store, ["serve", "--port", new URL(url).port, "--json"]);
      expect(second.code).toBe(0);
      expect(second.json).toEqual({ url, started: false });
    } finally {
      first.kill();
    }
  });

  test("a write makes no page file", () => {
    const store = tempStore();
    putNote(store, { id: "a" });
    kb(store, ["verdict", "helped", "a"]);
    expect(existsSync(join(store.home, "index.html"))).toBe(false);
  });

  test("fails with a clear message when there is no store", () => {
    const result = kb(join(tempDir(), "none"), ["serve", "--no-open"], { cwd: plain() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("kb add");
  });
});
