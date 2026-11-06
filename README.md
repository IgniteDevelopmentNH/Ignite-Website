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

Edit `src/` and `public/`, not the generated files at the root (`*.html`, `assets/`, and so on). Run the build, then commit the sources and the generated files together. The host serves the repo root, so no build step is needed when deploying.
