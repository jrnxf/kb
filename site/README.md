# kb site

The marketing page for kb, served at https://kb.jrnxf.co by a static-assets Cloudflare Worker (`kb-site`).

- `src/index.html` is the page. `bun run build` inlines `src/base.css`, `src/shared.css`, `src/shared.js`, `src/session.js`, `src/store.js` and `src/kbrank.json` into it and writes `dist/`. `src/404.html` is the page for an unknown path, built the same way.
- `lib.ts` holds what the build and `render.ts` share: the font files and the numbers of the example store (`{{n.chars}}` and the others in a page). `src/store.js` is the code that runs the example store, in the page and in the build.
- `src/session.js` mirrors the session start in `cli/context.ts`: the briefs, the index and the character budget. `src/kbrank.json` holds the constants of the CLI (`save` is the length of the save rule), and only the sizes and kinds of a real store, never titles. The brief size and the trigger marks in it are examples: that store is older than both.
- `src/serve.webp` and `src/serve-phone.webp` are captures of `kb serve` on the store of `scripts/seed.ts`, at 1100 x 680 and at a phone width. The build gives each a content hash and puts its path where `index.html` says `{{name}}`. Capture them again when the page of `kb serve` changes.
- `og.html` is the share card. `bun run render` turns it into `src/og.png`, and turns `src/favicon.svg` into `src/apple-touch-icon.png` and `src/favicon.ico`. Run it by hand after a change to `og.html`, `base.css`, `favicon.svg`, `render.ts` or the numbers in `lib.ts`, and commit the output. It needs the Playwright browser of the repo root: run `bun install` there, then `bunx playwright install chromium-headless-shell` once. It writes `src/render-hash`, and the build fails when an input changed and `render` did not run.
- Fonts are self-hosted from `@fontsource-variable`. The build gives each woff2 a content hash, preloads the latin files, and writes `dist/_headers`: immutable caching for `/assets/*`, and a `Link` header on the page (`/`) so Cloudflare sends 103 Early Hints.
- The build fails when its output breaks one of those rules, or when the page has a local host, IP or path.

`bun run preview` builds and serves the page with `wrangler dev`, which applies `_headers` like production.

Workers Builds deploys it: a push to `main` that touches `site/` runs `bunx wrangler deploy`. Other branches run `bunx wrangler versions upload` and get a preview URL, not the live site.
