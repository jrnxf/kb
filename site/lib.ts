// What build.ts and render.ts share: the font files, and the numbers of the example store.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = import.meta.dir;
export const src = (f: string) => readFileSync(join(here, "src", f), "utf8");

// Only the subsets this page can show: latin and latin-ext.
const FONTS = ["@fontsource-variable/geist/wght.css", "@fontsource-variable/geist-mono/wght.css"];
const SUBSETS = ["latin", "latin-ext"];
export type Font = { block: string; file: string; bytes: Uint8Array; subset: string };
export function fonts(): Font[] {
  const out: Font[] = [];
  for (const pkg of FONTS) {
    const cssPath = Bun.resolveSync(pkg, here);
    for (const block of readFileSync(cssPath, "utf8").match(/@font-face\s*{[^}]*}/g) ?? []) {
      const file = block.match(/url\(\.\/files\/([^)]+\.woff2)\)/)?.[1];
      const subset = file?.match(/-(latin-ext|latin|cyrillic-ext|cyrillic|vietnamese|greek-ext|greek)-wght-normal\.woff2$/)?.[1];
      if (!file || !subset || !SUBSETS.includes(subset)) continue;
      out.push({ block, file, subset, bytes: readFileSync(join(dirname(cssPath), "files", file)) });
    }
  }
  return out;
}

// The example store, run through the same code as the page. The page and the build agree on every number.
const { session } = require("./src/session.js");
const { demo } = require("./src/store.js");
export const RAW = JSON.parse(src("kbrank.json"));
export const D = demo(RAW, session);
export const NOTES = D.mkNotes(RAW.notes.length);
export const START = D.runOn(NOTES, RAW.chars);
// {{n.name}} in a page becomes one of these.
export const numbers: Record<string, string> = {
  chars: D.fmt(START.chars),
  budget: D.fmt(START.budget),
  fill: (START.chars / START.budget).toFixed(3),
  count: D.budgetCount(START),
  notes: D.fmt(RAW.chars),
};

// A hash of the inputs of `bun run render` that change its pixels: og.html, base.css, favicon.svg, the code of render.ts (not its comments)
// and the numbers that og.html shows. It leaves out the font files, so a font bump or a comment edit does not fail the build.
// A font bump that you want in og.png needs a `bun run render` by hand.
// render.ts writes the hash to src/render-hash, and build.ts compares it, so a change to an input cannot ship with a stale og.png or icon.
const OG_NUMBERS = ["chars", "budget", "fill"];
const noComments = (code: string) => code.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/\s.*$/gm, "");
export function renderHash(): string {
  const hash = createHash("sha256");
  const text = (s: string) => hash.update(s.replace(/\r\n/g, "\n") + "\0");
  text(readFileSync(join(here, "og.html"), "utf8"));
  text(noComments(readFileSync(join(here, "render.ts"), "utf8")));
  for (const f of ["base.css", "favicon.svg"]) text(src(f));
  text(JSON.stringify(OG_NUMBERS.map((k) => numbers[k])));
  return hash.digest("hex");
}
