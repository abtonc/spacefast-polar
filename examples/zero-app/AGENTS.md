# Spacefast Zero App Instructions

This directory is a capsule app built on Spacefast Zero. Zero is the runtime:
compiler, database, hosting, and platform services in one, driven entirely by
code and `sf` commands. The capsule is the app you write — the client,
server, and shared TypeScript here. There is nothing else to install or
configure.

## Hard rules

- Addressable pages live in `pages/`: Markdown and HTML are documents; TSX
  is a document unless it starts with "use client". Every TSX page exports its
  component as default. Client components live in `client/`, server code in
  `server/`, and shared pure TypeScript in `shared/`.
- An optional `client/index.tsx` may explicitly export `Layout`; it is not a page.
- Import `@spacefast/zero/server` only from server code. Import
  `@spacefast/zero/client`, `@spacefast/zero/kit`, and
  `@spacefast/zero/charts` only from client code. `shared/` imports nothing
  but its own relative files.
- The client reads through queries and writes through mutations. Queries are
  live — a mutation's committed writes refresh every subscribed client, so
  never poll. Endpoints exist for plain HTTP (webhooks, callers outside the
  app), not for your own UI.
- Database calls are async: await every `get`, `insert`, `update`,
  `delete`, `collect`, `take`, `first`, and `paginate`.
- Declare indexes with `.index(name, fields)` and read through `withIndex`.
  The built-in `by_creation` index covers unfiltered creation-order reads.
- Re-check ownership inside a mutation before updating or deleting a
  user-owned row.
- Auth is `ctx.auth` on the server and `useAuth()` on the client. Everyone
  starts as a guest; `<SignInWithGoogle />` from `@spacefast/zero/client`
  adds sign-in.
- Server-only variables: read through `ctx.env`, define in `.env.server`.
  They never reach the client or the build.
- Outbound `fetch` is unavailable in Zero handlers. Use a platform service
  whose intent can commit with the write handler.
- No Node built-ins, no dynamic `import()`, no `require()` anywhere in
  capsule code.

## Styling

Write Tailwind classes in JSX. Zero compiles them when you publish — do not
add a CSS, PostCSS, or Tailwind build pipeline; one is already built in.

- Class names must be static strings. Zero finds classes by scanning your
  source, so a computed class like `bg-${tone}-500` produces no CSS and
  the capsule ships unstyled. Branch to whole literals instead:
  `tone === "danger" ? "bg-danger" : "bg-success"`.
- Prefer the semantic tokens over stock palette classes: `canvas` (page),
  `surface` (panels), `ink` / `ink-muted` (text), `line` (borders),
  `accent`, `success`, `warning`, `danger`. `bg-surface text-ink
  border-line` re-skins from `theme.json` and handles light and dark on its
  own; `bg-neutral-900` does neither.
- shadcn names (`bg-background`, `text-muted-foreground`, `border-border`,
  `bg-primary`, …) alias to the same tokens and compile fine.

## Component kit

`@spacefast/zero/kit` is Zero's component set — pre-styled on the tokens and
re-skinned by `theme.json`. Reach for it before hand-rolling markup:

```tsx
import { Button, Card, Dialog, Input, Table } from "@spacefast/zero/kit";
```

The full set: Button, Field, Label, Input, TextArea, Select, Checkbox, Switch,
RadioGroup, Card, Badge, Avatar, Alert, Dialog, Tabs, Table, Breadcrumb,
Accordion, Tooltip, EmptyState, Spinner, Skeleton, Progress, Separator, Kbd,
CodeBlock. `Button` also accepts shadcn variant names (`default`,
`destructive`, `outline`, `link`).

## Charts

`@spacefast/zero/charts` ships `LineChart`, `BarChart`, `Sparkline`, and
`StatTile`, plus `seriesColor`, `niceTicks`, and `chartInk` for composing
your own on the same tokens. `recharts` and `lucide-react` also work with no
install.

## Forms

A form is a mutation: kit inputs on the client, a validating mutation writing a
table on the server. There is no separate forms product to reach for — the
`contact` starter template (`sf create my-form --runtime zero --template
contact`) is the reference for the whole pattern.

## Commands

```sh
sf dev                    # run locally
sf publish                # go live
sf logs runtime --follow  # tail what your published code logs
sf db                     # inspect the live schema
sf db dump                # print rows
```

## Current limits

- Table fields are `string()`, `boolean()`, and `id("table")`. Every row
  gets `id`, `createdAt`, and `updatedAt` for free (those names are
  reserved); store numbers and dates as strings for now.
- One server entry and an optional client layout module, declared in `sf.jsonc`.
- Endpoint `method` and `path` must be literal strings.
- npm packages bundle on the client only. Server code imports
  `@spacefast/zero/server` and its own files, nothing else.
- Your client code plus any npm packages must bundle under 8 MB. Platform
  modules (the SDK, kit, charts, preact, recharts, lucide) don't count toward
  that cap and aren't in your bundle at all: they're served from the platform's
  own immutable URLs, so the browser fetches them once and keeps them across
  every publish. Import what you use — anything you don't import is never
  fetched.
- File uploads go through `storage.upload(file)` from
  `@spacefast/zero/client`; local dev keeps uploads in memory.
- `sf dev` state is in memory and resets on restart; pass
  `--state-backend sqlite` to keep it.
- `theme.json` presets and utility classes are the whole styling surface —
  `@plugin` and `@config` CSS directives are rejected.
