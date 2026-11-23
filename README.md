# Ignite Development website

Static marketing site for ignitedevelopment.net. No framework and no npm dependencies.

```bash
node build.mjs   # writes the finished site to the repo root
node serve.mjs   # previews it at http://localhost:8090
```

- `src/pages/`: one file per page. The first line is a JSON comment with the title and description.
- `src/partials/`: shared pieces, included with `{{> name}}`.
- `src/layout.html`: nav, footer, and `<head>` for every page.
- `public/`: CSS, JS, fonts, images, and `_redirects` and `_headers`, copied to the root as is.

## /meet scheduler

`/meet` is an unlisted, noindexed availability poll (a branded when2meet). Clients enter a four-digit code (or open `/meet/1234`) and paint the times they're free. The **Admin** button in the top right opens the dashboard for creating events and reading results.

- `src/pages/meet.html` (uses `src/layout-app.html`), `public/assets/meet.css`, `public/assets/meet.js`: the page.
- `worker/index.js`: the Cloudflare Worker behind `/api/*` and `/meet/*`. Everything else is served as static files without touching it.
- Data lives in a D1 database (`ignite-meet`, binding `DB`). Wrangler creates it on the first deploy and the Worker creates its own tables.
- The admin password is the `ADMIN_PASSWORD` secret. Set or change it with `npx wrangler secret put ADMIN_PASSWORD` or in the Cloudflare dashboard (Workers > ignite-site > Settings > Variables and Secrets). Changing it logs everyone out.

To try it locally with a throwaway database, put `ADMIN_PASSWORD=anything` in `.dev.vars` (git-ignored), then:

```bash
node build.mjs && npx wrangler dev
```

## Editing

Edit `src/` and `public/`, not the generated files at the root (`*.html`, `assets/`, and so on). Run the build, then commit the sources and the generated files together. The host serves the repo root, so no build step is needed when deploying.
