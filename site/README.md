# spacefast-polar docs site

The documentation website for `spacefast-polar`. It builds to plain static files with no npm dependencies.

## Build

```bash
node site/build.mjs
```

Needs Node 20 or later. It writes the site to `site/dist/` (git-ignored): one HTML file per page, `style.css`, a small `copy.js` for code copy buttons, the logo from `assets/icon.svg`, and `sf.jsonc`.

For coding agents it also writes:

- `<page>.md.txt`: every page as Markdown, linked from each page's `<head>` and footer. The `.txt` ending matters: Spacefast renders uploaded `.md` files into pages instead of serving them raw.
- `llms.txt`: an [llms.txt](https://llmstxt.org) index with the facts agents most often get wrong, and links to every page.
- `llms-full.txt`: all pages in one file.
- `agent-prompt.txt`: the setup prompt shown on the home page, from `site/agent-prompt.md`.

Links in `llms.txt` and the prompt are absolute, using `homepage` from `package.json` (https://sf-polar.space.fast). Set `SITE_URL` to build for another address.

## Preview

```bash
python3 -m http.server -d site/dist
```

Then open http://localhost:8000.

## Edit

- Pages are Markdown files in `site/pages/`. Each starts with front matter: `title`, `description` (the meta description), and an optional `lead`.
- The sidebar order and labels are the `NAV` list at the top of `site/build.mjs`. A new page needs an entry there.
- The Markdown subset: `##` to `####` headings (add `{#id}` to set the anchor), paragraphs, `-` and `1.` lists, pipe tables, fenced code with an optional file name after the language (`ts server/index.ts`), `:::note`, `:::tip` and `:::warning` blocks, raw HTML blocks, and inline code, links, bold, and emphasis. Inline code like `GET /api/polar/checkout` renders as a route.
- Code is highlighted at build time for `ts`, `tsx`, `js`, `bash`, `json`, and `jsonc`.
- `{{version}}` and `{{apiVersion}}` are replaced with the package version and the pinned Polar API version.
- `<!-- flow -->` and `<!-- agent-prompt -->` on their own line insert the home page's diagram and the agent prompt. Edit the prompt in `site/agent-prompt.md`.
- Styles are in `site/style.css`, with light and dark themes from `prefers-color-scheme`.

## Publish

The site is hosted at https://sf-polar.space.fast (the `sf-polar` space, public). To update it:

```bash
npm run docs:build
sf publish site/dist --space sf-polar
```

Spacefast reserves space names containing "spacefast", which is why the space is `sf-polar`.
