# Ignite Development website

Static marketing site for ignitedevelopment.net. No framework and no npm dependencies.

```bash
node build.mjs   # writes the finished site to dist/
node serve.mjs   # previews dist/ at http://localhost:8090
```

- `src/pages/`: one file per page. The first line is a JSON comment with the title and description.
- `src/partials/`: shared pieces, included with `{{> name}}`.
- `src/layout.html`: nav, footer, and `<head>` for every page.
- `public/`: CSS, JS, fonts, images, and Cloudflare `_redirects` and `_headers`, copied as is.

To deploy on Cloudflare, use `node build.mjs` as the build command and `dist` as the output directory.
