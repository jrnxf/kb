// Builds the kb site into dist/.
// - index.html and 404.html: each page with its CSS and JS inlined, so the only other requests are the fonts and the pictures.
// - assets/: the self-hosted woff2 files and the pictures, each name with a content hash, so they can be cached forever.
// - _headers: HSTS for every path (one year, this host only), immutable caching for assets/, and a Link header on the page (/) so Cloudflare can send 103 Early Hints.
// - the files at fixed paths: favicons, robots.txt, sitemap.xml and llms.txt.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { D, NOTES, RAW, START, fonts, numbers, renderHash, src } from "./lib.ts";

const here = import.meta.dir;
const ORIGIN = "https://kb.jrnxf.co";
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });
const hashed = (file: string, bytes: Uint8Array) => file.replace(/(\.\w+)$/, `-${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}$1`);

// Fonts. The first paint needs only latin, so only latin is preloaded. latin-ext stays lazy through its unicode-range.
const faces: string[] = [], preloads: string[] = [];
for (const f of fonts()) {
  const name = hashed(f.file, f.bytes);
  writeFileSync(join(dist, "assets", name), f.bytes);
  faces.push(f.block.replace(/url\(\.\/files\/[^)]+\)/, `url(/assets/${name})`));
  if (f.subset === "latin") preloads.push(`/assets/${name}`);
}

// Pictures. Each name gets a content hash, like the fonts, and {{name}} in a page becomes its path.
const IMAGES = ["serve.webp", "serve-phone.webp", "og.png"];
const pictures = new Map<string, string>();
for (const file of IMAGES) {
  const bytes = readFileSync(join(here, "src", file)), name = hashed(file, bytes);
  writeFileSync(join(dist, "assets", name), bytes);
  pictures.set(file, `/assets/${name}`);
}

// What a reader without JavaScript sees in the two widgets that draw, from the same code as the page. The packer shows its last state.
// The growth widget shows its first state, in the size of the live one.
function packer() {
  const S = START, tier = D.tiersOf(S), last = D.steps(S, NOTES, RAW.chars)[5];
  const cells = [...S.ranked].map((n) => `<i class="cell ${tier.get(n)}"></i>`).join("");
  return `${D.packerCap(last, 5)}
    <div class="p-field still" role="img" aria-label="${S.ranked.length} notes in rank order, colored by what each gets">${cells}</div><div class="p-legend">${D.legend()}</div>
    <div class="p-bars">${D.packerBars(S, 5)}</div>
    <div class="p-tally">${D.tally(S)}</div>`;
}

const sess = src("session.js").replace(/^if \(typeof module.*$/m, "");
const store = src("store.js").replace(/^if \(typeof module.*$/m, "");
const js = src("shared.js").replace("/*SESSION*/", () => sess).replace("/*STORE*/", () => store).replace("/*RANK*/", () => src("kbrank.json").trim());
const page = (file: string) => src(file)
  .replace("<!--FONT_PRELOADS-->", () => preloads.map((h) => `<link rel="preload" href="${h}" as="font" type="font/woff2" crossorigin>`).join("\n"))
  .replace("/*FONT_FACES*/", () => faces.join("\n"))
  .replace("/*SHARED_CSS*/", () => src("shared.css"))
  .replace("/*BASE_CSS*/", () => src("base.css"))
  .replace("<!--PACKER-->", packer)
  .replace("<!--GROWTH-->", D.growthHTML)
  .replace(/\{\{n\.(\w+)\}\}/g, (all, k) => numbers[k] ?? all)
  .replace(/\{\{([\w.-]+)\}\}/g, (all, name) => pictures.get(name) ?? all)
  .replace("/*SHARED_JS*/", () => js.replace(/<\/script/g, "<\\/script"));
const html = page("index.html"), notFound = page("404.html");
writeFileSync(join(dist, "index.html"), html);
// wrangler.jsonc sets not_found_handling to 404-page, so any unknown path gets this page with a 404 status.
writeFileSync(join(dist, "404.html"), notFound);
for (const f of ["favicon.svg", "favicon.ico", "apple-touch-icon.png", "llms.txt"]) copyFileSync(join(here, "src", f), join(dist, f));
// Cloudflare's managed robots.txt, when it is on, puts its lines before this file. The Sitemap line stays.
writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
writeFileSync(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${ORIGIN}/</loc></url>\n</urlset>\n`);

// The Link header must name the same files as the preload tags, with crossorigin on both, or the browser fetches a font twice.
const link = preloads.map((h) => `<${h}>; rel=preload; as=font; type=font/woff2; crossorigin`).join(", ");
// The font Link goes only on the page: the icons, robots.txt, sitemap.xml and llms.txt do not use the fonts.
writeFileSync(join(dist, "_headers"), `/*
  Strict-Transport-Security: max-age=31536000
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/
  Link: ${link}

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/llms.txt
  Content-Type: text/plain; charset=utf-8
`);

// Fail the build, and so the deploy, when the output breaks one of the rules above.
const fail = (why: string) => { console.error(`build: ${why}`); process.exit(1); };
// og.png, apple-touch-icon.png and favicon.ico are rendered by hand. Fail when an input of that render changed after it.
if ((existsSync(join(here, "src", "render-hash")) ? readFileSync(join(here, "src", "render-hash"), "utf8").trim() : "") !== renderHash()) fail("src/og.png and the icons are out of date: run `bun run render` and commit the output");
if (preloads.length !== 2) fail(`expected 2 latin font preloads, found ${preloads.length}`);
if (faces.length !== 4) fail(`expected 4 @font-face rules (2 fonts x latin, latin-ext), found ${faces.length}`);
for (const [name, out] of [["index.html", html], ["404.html", notFound]]) {
  for (const left of ["<!--FONT_PRELOADS-->", "/*FONT_FACES*/", "/*SHARED_CSS*/", "/*BASE_CSS*/", "/*SHARED_JS*/", "/*SESSION*/", "/*STORE*/", "/*RANK*/", "<!--PACKER-->", "<!--GROWTH-->"]) if (out.includes(left)) fail(`placeholder ${left} is still in ${name}`);
  if (/\{\{[\w.-]+\}\}/.test(out)) fail(`a {{name}} in ${name} names no picture in IMAGES and no number`);
  if (/fonts\.googleapis|fonts\.gstatic/.test(out)) fail(`${name} still loads Google Fonts`);
}
// The site is public: no LAN hosts, private IPs or local paths in any file that it publishes. Fonts and pictures are binary, and are skipped.
const TEXT = /\.(html|txt|xml|svg|json|js|css)$|^_headers$/;
for (const name of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
  if (TEXT.test(name) && /\.lan\.|\/Users\/|127\.0\.0\.1|192\.168\.|\b10\.\d+\.\d+\.\d+/.test(readFileSync(join(dist, name), "utf8"))) fail(`${name} has a local host, IP or path`);
}
if (!html.includes(`content="${ORIGIN}/assets/`)) fail("og:image is not an absolute URL of a hashed picture");
console.log(`dist: index.html ${(html.length / 1024).toFixed(1)} KB, 404.html ${(notFound.length / 1024).toFixed(1)} KB, ${faces.length} font files, preloads: ${preloads.join(", ")}`);
