// Renders the pictures that the build only copies: src/og.png (the share card), src/apple-touch-icon.png and src/favicon.ico.
// Run it by hand with `bun run render` after a change to og.html, base.css, favicon.svg, render.ts or the numbers it shows, and commit the output.
// It also writes src/render-hash, which build.ts checks, so the build fails when an input changed and this did not run.
// It needs the Playwright browser of the repo root (`bunx playwright install chromium-headless-shell` once).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { fonts, numbers, renderHash, src } from "./lib.ts";

const here = import.meta.dir;
const faces = fonts().map((f) => f.block.replace(/url\(\.\/files\/[^)]+\)/, `url(data:font/woff2;base64,${Buffer.from(f.bytes).toString("base64")})`)).join("\n");
const og = (await Bun.file(join(here, "og.html")).text())
  .replace("/*FONT_FACES*/", () => faces)
  .replace("/*BASE_CSS*/", () => src("base.css"))
  .replace(/\{\{n\.(\w+)\}\}/g, (all, k) => numbers[k] ?? all);
if (/\{\{|\/\*[A-Z_]+\*\//.test(og)) throw new Error("og.html has a placeholder that render.ts did not fill");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(og, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
writeFileSync(join(here, "src", "og.png"), await page.screenshot({ type: "png" }));

// The icons: the mark of favicon.svg, full bleed, since iOS rounds the corners of a touch icon by itself.
const mark = (px: number, bleed: boolean) => {
  let svg = src("favicon.svg").replace("<svg ", `<svg width="${px}" height="${px}" style="display:block" `);
  if (bleed) svg = svg.replace(/rx="[\d.]+"/, 'rx="0"');
  return `<body style="margin:0;background:transparent">${svg}</body>`;
};
const shot = async (px: number, bleed: boolean) => {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(mark(px, bleed));
  return page.screenshot({ type: "png", omitBackground: !bleed });
};
writeFileSync(join(here, "src", "apple-touch-icon.png"), await shot(180, true));

// favicon.ico: one 32 x 32 PNG in an ICO wrapper (a 6-byte header and one 16-byte directory entry). Every browser reads a PNG inside an ICO.
const png = await shot(32, false);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); // reserved, type icon, one image
ico.writeUInt8(32, 6); ico.writeUInt8(32, 7); ico.writeUInt8(0, 8); ico.writeUInt8(0, 9); // width, height, no palette, reserved
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); // planes, bits per pixel
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18); // size and offset of the PNG
writeFileSync(join(here, "src", "favicon.ico"), Buffer.concat([ico, png]));

await browser.close();
writeFileSync(join(here, "src", "render-hash"), `${renderHash()}\n`);
console.log("render: src/og.png, src/apple-touch-icon.png, src/favicon.ico, src/render-hash");
