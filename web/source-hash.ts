// A hash of every file that goes into web/dist. The build writes it to dist/.source-hash, and a test
// compares it with the sources, so a change to the page cannot land without a fresh build.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const WEB = import.meta.dirname;
const INPUTS = ["src", "index.html", "package.json", "bun.lock", "vite.config.ts", "tsconfig.json", "../cli/wire.ts"];

function files(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => files(join(path, entry.name))).sort();
  } catch {
    return [path];
  }
}

export function sourceHash(): string {
  const hash = createHash("sha256");
  for (const input of INPUTS) {
    for (const file of files(join(WEB, input))) {
      // Line endings depend on the checkout, not on the page.
      hash.update(`${relative(WEB, file).split("\\").join("/")}\0${readFileSync(file, "utf8").replace(/\r\n/g, "\n")}\0`);
    }
  }
  return hash.digest("hex");
}
