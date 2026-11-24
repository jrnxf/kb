import { expect, test } from "bun:test";
import worker from "../site/worker.ts";

const env = { ASSETS: { fetch: () => new Response("asset") } } as unknown as Parameters<typeof worker.fetch>[1];

test("plain http gets a 301 to https, with the path and the query", async () => {
  const res = await worker.fetch(new Request("http://example.com/a/b?x=1&y=2"), env);
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("https://example.com/a/b?x=1&y=2");
});

test("https goes to the assets", async () => {
  const res = await worker.fetch(new Request("https://example.com/a"), env);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("asset");
});
