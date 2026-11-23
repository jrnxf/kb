// Builds the kb site into dist/.
// - index.html: one page, with its CSS and JS inlined, so the only other requests are the fonts.
// - assets/: the self-hosted woff2 files, each name with a content hash, so they can be cached forever.
// - _headers: immutable caching for assets/, and Link headers on the HTML so Cloudflare can send 103 Early Hints.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = import.meta.dir;
const src = (f: string) => readFileSync(join(here, "src", f), "utf8");
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });

// Fonts. Only the subsets this page can show: latin and latin-ext. The first paint needs only latin, so only latin is preloaded.
// latin-ext stays lazy through its unicode-range.
const FONTS = ["@fontsource-variable/geist/wght.css", "@fontsource-variable/geist-mono/wght.css"];
const SUBSETS = ["latin", "latin-ext"];
const faces: string[] = [], preloads: string[] = [];
for (const pkg of FONTS) {
  const cssPath = Bun.resolveSync(pkg, here);
  for (const block of readFileSync(cssPath, "utf8").match(/@font-face\s*{[^}]*}/g) ?? []) {
    const file = block.match(/url\(\.\/files\/([^)]+\.woff2)\)/)?.[1];
    const subset = file?.match(/-(latin-ext|latin|cyrillic-ext|cyrillic|vietnamese|greek-ext|greek)-wght-normal\.woff2$/)?.[1];
    if (!file || !subset || !SUBSETS.includes(subset)) continue;
    const bytes = readFileSync(join(dirname(cssPath), "files", file));
    const hashed = file.replace(/\.woff2$/, `-${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}.woff2`);
    copyFileSync(join(dirname(cssPath), "files", file), join(dist, "assets", hashed));
    faces.push(block.replace(/url\(\.\/files\/[^)]+\)/, `url(/assets/${hashed})`));
    if (subset === "latin") preloads.push(`/assets/${hashed}`);
  }
}

// Pictures. Each name gets a content hash, like the fonts, and {{name}} in index.html becomes its path.
const IMAGES = ["serve.webp", "serve-phone.webp"];
const pictures = new Map<string, string>();
for (const file of IMAGES) {
  const bytes = readFileSync(join(here, "src", file));
  const hashed = file.replace(/\.webp$/, `-${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}.webp`);
  copyFileSync(join(here, "src", file), join(dist, "assets", hashed));
  pictures.set(file, `/assets/${hashed}`);
}

const sess = src("session.js").replace(/^if \(typeof module.*$/m, "");
const js = src("shared.js").replace("/*SESSION*/", () => sess).replace("/*RANK*/", () => src("kbrank.json").trim());
const html = src("index.html")
  .replace("<!--FONT_PRELOADS-->", () => preloads.map((h) => `<link rel="preload" href="${h}" as="font" type="font/woff2" crossorigin>`).join("\n"))
  .replace("/*FONT_FACES*/", () => faces.join("\n"))
  .replace("/*SHARED_CSS*/", () => src("shared.css"))
  .replace(/\{\{([\w.-]+)\}\}/g, (all, name) => pictures.get(name) ?? all)
  .replace("/*SHARED_JS*/", () => js.replace(/<\/script/g, "<\\/script"));
writeFileSync(join(dist, "index.html"), html);
copyFileSync(join(here, "src", "favicon.svg"), join(dist, "favicon.svg"));

// The Link header must name the same files as the preload tags, with crossorigin on both, or the browser fetches a font twice.
const link = preloads.map((h) => `<${h}>; rel=preload; as=font; type=font/woff2; crossorigin`).join(", ");
writeFileSync(join(dist, "_headers"), `/*
  Link: ${link}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/assets/*
  ! Link
  Cache-Control: public, max-age=31536000, immutable
`);

// Fail the build, and so the deploy, when the output breaks one of the rules above.
const fail = (why: string) => { console.error(`build: ${why}`); process.exit(1); };
if (preloads.length !== 2) fail(`expected 2 latin font preloads, found ${preloads.length}`);
if (faces.length !== 4) fail(`expected 4 @font-face rules (2 fonts x latin, latin-ext), found ${faces.length}`);
for (const left of ["<!--FONT_PRELOADS-->", "/*FONT_FACES*/", "/*SHARED_CSS*/", "/*SHARED_JS*/", "/*SESSION*/", "/*RANK*/"]) if (html.includes(left)) fail(`placeholder ${left} is still in index.html`);
if (/\{\{[\w.-]+\}\}/.test(html)) fail("a {{picture}} in index.html names no file in IMAGES");
if (/fonts\.googleapis|fonts\.gstatic/.test(html)) fail("index.html still loads Google Fonts");
// The site is public: no LAN hosts, private IPs or local paths.
if (/\.lan\.|\/Users\/|127\.0\.0\.1|192\.168\.|\b10\.\d+\.\d+\.\d+/.test(html)) fail("index.html has a local host, IP or path");
console.log(`dist: index.html ${(html.length / 1024).toFixed(1)} KB, ${faces.length} font files, preloads: ${preloads.join(", ")}`);
