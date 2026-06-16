# Loom Docs Site

Loom's public website is a Vocs docs app under `docs/site`, matching the
structure used by Kohaku.

```sh
npm --prefix docs/site ci
npm run site:dev
npm run site:build
```

The deployed site uses `basePath: "/loom"` and is published by
`.github/workflows/pages.yml`.

On Windows paths with non-ASCII characters, `vocs build` may fail while
generating virtual routes. The GitHub Pages build runs on Linux and is the
release build authority for the site.
