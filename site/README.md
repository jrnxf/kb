# kb site

The marketing page for kb, served at https://kb.jrnxf.co by a static-assets Cloudflare Worker (`kb-site`).

- `src/index.html` is the page. `bun run build` inlines `src/shared.css`, `src/shared.js`, `src/session.js` and `src/kbrank.json` into it and writes `dist/`.
- `src/session.js` mirrors the packer in `cli/context.ts`. `src/kbrank.json` holds only the sizes and kinds of a real store, never titles.
- Fonts are self-hosted from `@fontsource-variable`. The build gives each woff2 a content hash, preloads the latin files, and writes `dist/_headers`: immutable caching for `/assets/*`, and `Link` headers on the HTML so Cloudflare sends 103 Early Hints.
- The build fails when its output breaks one of those rules, or when the page has a local host, IP or path.

`bun run preview` builds and serves the page with `wrangler dev`, which applies `_headers` like production.

Workers Builds deploys it: a push to `main` that touches `site/` runs `bunx wrangler deploy`. Other branches run `bunx wrangler versions upload` and get a preview URL, not the live site.
