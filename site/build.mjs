#!/usr/bin/env node
// Builds the spacefast-polar documentation into site/dist/.
//
//   node site/build.mjs
//
// Node 20+, built-ins only. Pages are Markdown files in site/pages/, rendered
// by the small Markdown subset and syntax highlighter below. Every page is also
// written as Markdown next to its HTML (<page>.md.txt, since Spacefast renders
// uploaded .md files instead of serving them), with llms.txt and llms-full.txt.
//
// Links in llms.txt and the agent prompt are absolute, using package.json's
// "homepage". Set SITE_URL to override it, or SITE_URL= to build without one.

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(siteDir, "..");
const outDir = join(siteDir, "dist");
/** Set in build() from SITE_URL or package.json's homepage. */
let siteUrl = "";
/** Set in build() before any page renders. */
let agentPrompt = "";

const NAV = [
  {
    group: "Start",
    pages: [
      ["index", "Overview"],
      ["get-started", "Get started"],
    ],
  },
  {
    group: "Guides",
    pages: [
      ["zero", "Zero capsules"],
      ["functions", "Functions workers"],
    ],
  },
  {
    group: "Reference",
    pages: [
      ["checkout", "Checkout and portal"],
      ["webhooks", "Webhooks"],
      ["entitlements", "Entitlements"],
      ["client", "API client"],
      ["cli", "CLI"],
    ],
  },
  {
    group: "Help",
    pages: [
      ["troubleshooting", "Troubleshooting"],
      ["examples", "Examples"],
    ],
  },
];

const ORDER = NAV.flatMap((group) => group.pages.map(([slug, label]) => ({ slug, label })));

// ---------------------------------------------------------------------------
// Utilities

const escapeHtml = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const href = (slug) => (slug === "index" ? "index.html" : `${slug}.html`);

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseFrontMatter(source) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!match) throw new Error("Page is missing front matter");
  const data = {};
  for (const line of match[1].split("\n")) {
    const index = line.indexOf(":");
    if (index > 0) data[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return { data, body: source.slice(match[0].length) };
}

// ---------------------------------------------------------------------------
// Syntax highlighting: ts / tsx / js, bash, json / jsonc. Anything else is
// escaped as plain text.

const span = (cls, text) => (cls ? `<span class="t-${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));

const TS_KEYWORDS = new Set(
  (
    "as async await break case catch class const continue default delete do else enum export extends " +
    "finally for from function if implements import in instanceof interface keyof let new of readonly " +
    "return satisfies static switch throw try type typeof var void while yield"
  ).split(" "),
);
const TS_LITERALS = new Set(["true", "false", "null", "undefined", "this"]);

function highlightTs(src, jsx) {
  let out = "";
  let i = 0;
  let lastSig = "\n"; // last significant (non-space) character emitted
  let lineStart = true;
  const n = src.length;

  const at = (re) => {
    re.lastIndex = i;
    const m = re.exec(src);
    return m ? m[0] : null;
  };
  const emit = (cls, text) => {
    out += span(cls, text);
    i += text.length;
    const trimmed = text.replace(/\s+$/, "");
    if (trimmed) lastSig = trimmed[trimmed.length - 1];
    if (text.includes("\n")) lineStart = /\n\s*$/.test(text);
    else if (trimmed) lineStart = false;
  };
  const nextSig = (from) => {
    let j = from;
    while (j < n && (src[j] === " " || src[j] === "\t")) j++;
    return src[j] ?? "";
  };
  const balanced = (from) => {
    // Index just past the `}` matching the `{` at `from`, skipping strings.
    let depth = 0;
    for (let j = from; j < n; j++) {
      const c = src[j];
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        for (j++; j < n && src[j] !== quote; j++) if (src[j] === "\\") j++;
      } else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return j + 1;
    }
    return n;
  };

  // Parses one JSX tag starting at `<`. Returns +1 for an opening tag,
  // -1 for a closing tag, 0 for a self-closing one.
  const jsxTag = () => {
    let kind = 1;
    emit("punc", "<");
    if (src[i] === "/") {
      emit("punc", "/");
      kind = -1;
    }
    const name = at(/[A-Za-z][\w.:-]*/y);
    if (name) emit("tag", name);
    while (i < n) {
      const ws = at(/\s+/y);
      if (ws) {
        emit(null, ws);
        continue;
      }
      if (src.startsWith("/>", i)) {
        emit("punc", "/>");
        return 0;
      }
      if (src[i] === ">") {
        emit("punc", ">");
        return kind;
      }
      if (src[i] === "{") {
        const end = balanced(i);
        out += highlightTs(src.slice(i, end), true);
        i = end;
        continue;
      }
      const str = at(/"[^"]*"|'[^']*'/y);
      if (str) {
        emit("str", str);
        continue;
      }
      const attr = at(/[A-Za-z_:][\w:.-]*/y);
      if (attr) {
        emit("attr", attr);
        continue;
      }
      emit(null, src[i]);
    }
    return 0;
  };

  // Parses JSX starting at a `<` until its outermost element closes.
  const jsxElement = () => {
    let depth = jsxTag();
    while (depth > 0 && i < n) {
      if (src[i] === "<") {
        depth += jsxTag();
      } else if (src[i] === "{") {
        const end = balanced(i);
        out += highlightTs(src.slice(i, end), true);
        i = end;
      } else {
        const text = at(/[^<{]+/y);
        out += escapeHtml(text);
        i += text.length;
      }
    }
    lastSig = ">";
  };

  while (i < n) {
    const c = src[i];
    let m;
    if ((m = at(/\/\/[^\n]*/y)) || (m = at(/\/\*[\s\S]*?\*\//y))) {
      emit("com", m);
    } else if ((m = at(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y))) {
      emit("str", m);
    } else if ((m = at(/\d[\d_]*(?:\.\d+)?(?![\w$])/y)) && !/[\w$]/.test(src[i - 1] ?? "")) {
      emit("num", m);
    } else if ((m = at(/[A-Za-z_$][\w$]*/y))) {
      const after = nextSig(i + m.length);
      let cls = null;
      if (TS_KEYWORDS.has(m)) cls = "kw";
      else if (TS_LITERALS.has(m)) cls = "lit";
      else if (after === "(") cls = "fn";
      else if (after === ":" && src[i + m.length] !== ":" && (lastSig === "{" || lastSig === "," || lineStart)) cls = "prop";
      else if (/^[A-Z]/.test(m)) cls = "type";
      emit(cls, m);
    } else if (jsx && c === "<" && /[A-Za-z/>]/.test(src[i + 1] ?? "") && !/[\w$)\]]/.test(lastSig)) {
      jsxElement();
    } else if ((m = at(/\s+/y))) {
      emit(null, m);
    } else {
      emit(/[{}()[\];,.]/.test(c) ? null : "op", c);
    }
  }
  return out;
}

function highlightBash(src) {
  let out = "";
  for (const line of src.split("\n")) {
    let i = 0;
    let commandNext = true;
    const n = line.length;
    let html = "";
    while (i < n) {
      const rest = line.slice(i);
      let m;
      if (/^\s/.test(rest)) {
        m = /^\s+/.exec(rest)[0];
        html += m;
      } else if (rest[0] === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        m = rest;
        html += span("com", m);
      } else if ((m = /^"(?:[^"\\]|\\.)*"|^'[^']*'/.exec(rest)?.[0])) {
        html += span("str", m);
        commandNext = false;
      } else if ((m = /^\$\{?[A-Za-z_][\w]*\}?/.exec(rest)?.[0])) {
        html += span("var", m);
      } else if ((m = /^(?:\|\||&&|[|;])/.exec(rest)?.[0])) {
        html += span("op", m);
        commandNext = true;
      } else if (commandNext && (m = /^[A-Za-z_][\w]*=/.exec(rest)?.[0])) {
        html += span("var", m);
        const value = /^\S*/.exec(line.slice(i + m.length))[0];
        html += escapeHtml(value);
        m += value;
      } else if ((m = /^-{1,2}[A-Za-z][\w-]*/.exec(rest)?.[0]) && /\s/.test(line[i - 1] ?? " ")) {
        html += span("attr", m);
      } else {
        m = /^[^\s"'|;&]+/.exec(rest)?.[0] ?? rest[0];
        html += commandNext ? span("fn", m) : escapeHtml(m);
        commandNext = false;
      }
      i += m.length;
    }
    out += `${html}\n`;
  }
  return out.slice(0, -1);
}

function highlightJson(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const rest = src.slice(i);
    let m;
    if ((m = /^\/\/[^\n]*/.exec(rest)?.[0])) out += span("com", m);
    else if ((m = /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0])) {
      const isKey = /^\s*:/.test(src.slice(i + m.length));
      out += span(isKey ? "prop" : "str", m);
    } else if ((m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)?.[0])) out += span("num", m);
    else if ((m = /^(?:true|false|null)\b/.exec(rest)?.[0])) out += span("lit", m);
    else {
      m = rest[0];
      out += escapeHtml(m);
    }
    i += m.length;
  }
  return out;
}

function highlight(code, lang) {
  switch (lang) {
    case "ts":
    case "js":
    case "typescript":
    case "javascript":
      return highlightTs(code, false);
    case "tsx":
    case "jsx":
      return highlightTs(code, true);
    case "bash":
    case "sh":
    case "shell":
      return highlightBash(code);
    case "json":
    case "jsonc":
      return highlightJson(code);
    default:
      return escapeHtml(code);
  }
}

// ---------------------------------------------------------------------------
// Markdown subset: front matter, ## to #### headings, paragraphs, - and 1.
// lists, pipe tables, fenced code with an optional file name, :::note and
// :::warning containers, raw HTML blocks, and <!-- component --> slots.
// Inline: `code`, [links](url), **bold**, *emphasis*.

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;

function inlineCode(text) {
  const route = ROUTE.exec(text);
  if (route) {
    return `<code class="route"><span class="method method-${route[1].toLowerCase()}">${route[1]}</span> ${escapeHtml(route[2])}</code>`;
  }
  return `<code>${escapeHtml(text)}</code>`;
}

function inline(text) {
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index));
    if (m[1]) out += inlineCode(m[2].replace(/^ (.*) $/, "$1"));
    else if (m[3]) {
      const external = /^https?:\/\//.test(m[4]);
      out += `<a href="${escapeHtml(m[4])}"${external ? ' rel="noopener"' : ""}>${inline(m[3])}</a>`;
    } else if (m[5]) out += `<strong>${inline(m[5])}</strong>`;
    else if (m[6]) out += `<em>${inline(m[6])}</em>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function splitRow(line) {
  const cells = [];
  let cell = "";
  let inCode = false;
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "`") {
      inCode = !inCode;
      cell += c;
    } else if (c === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

function renderMarkdown(source, state, components) {
  const lines = source.split("\n");
  let html = "";
  let paragraph = [];

  const flush = () => {
    if (paragraph.length) html += `<p>${inline(paragraph.join(" "))}</p>\n`;
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      flush();
      continue;
    }

    const fence = /^```(\S*)\s*(.*)$/.exec(line);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      const lang = fence[1] || "text";
      const file = fence[2].trim();
      const caption = file ? `<figcaption>${escapeHtml(file)}</figcaption>` : "";
      html +=
        `<figure class="code"${file ? "" : ' data-bare=""'}>${caption}` +
        `<pre class="lang-${escapeHtml(lang)}" data-lang="${escapeHtml(lang)}"><code>${highlight(code.join("\n"), lang)}</code></pre></figure>\n`;
      continue;
    }

    const container = /^:::(note|warning|tip)\s*(.*)$/.exec(line);
    if (container) {
      flush();
      const inner = [];
      let depth = 1;
      for (i++; i < lines.length; i++) {
        if (/^:::\w/.test(lines[i])) depth++;
        else if (/^:::\s*$/.test(lines[i]) && --depth === 0) break;
        inner.push(lines[i]);
      }
      const title = container[2] ? `<p class="callout-title">${inline(container[2])}</p>` : "";
      html += `<aside class="callout callout-${container[1]}">${title}${renderMarkdown(inner.join("\n"), state, components)}</aside>\n`;
      continue;
    }

    const slot = /^<!--\s*([\w-]+)\s*-->$/.exec(line.trim());
    if (slot) {
      flush();
      if (!components[slot[1]]) throw new Error(`Unknown component: ${slot[1]}`);
      html += components[slot[1]]() + "\n";
      continue;
    }

    if (/^<[a-zA-Z/!]/.test(line)) {
      flush();
      const block = [];
      for (; i < lines.length && lines[i].trim(); i++) block.push(lines[i]);
      html += block.join("\n") + "\n";
      continue;
    }

    const heading = /^(#{2,4})\s+(.*?)(?:\s+\{#([\w-]+)\})?\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      let id = heading[3] || slugify(heading[2]);
      if (state.ids.has(id)) {
        let k = 2;
        while (state.ids.has(`${id}-${k}`)) k++;
        id = `${id}-${k}`;
      }
      state.ids.add(id);
      const content = inline(heading[2]);
      if (level === 2) state.toc.push({ id, html: content });
      html += `<h${level} id="${id}"><a class="anchor" href="#${id}">${content}</a></h${level}>\n`;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flush();
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      const header = splitRow(rows[0]);
      const body = rows.slice(2).map(splitRow);
      html +=
        `<div class="table-wrap"><table>\n<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>\n<tbody>\n` +
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("\n") +
        `\n</tbody></table></div>\n`;
      continue;
    }

    const listItem = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
    if (listItem.test(line) && !/^\s{2,}/.test(line)) {
      flush();
      const ordered = /\d/.test(listItem.exec(line)[2]);
      const items = [];
      for (; i < lines.length; i++) {
        const m = listItem.exec(lines[i]);
        if (m && !m[1]) items.push(m[3]);
        else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
      }
      i--;
      const tag = ordered ? "ol" : "ul";
      html += `<${tag}>\n${items.map((item) => `<li>${inline(item)}</li>`).join("\n")}\n</${tag}>\n`;
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();
  return html;
}

// ---------------------------------------------------------------------------
// Components

const components = {
  // The copyable prompt for coding agents, from site/agent-prompt.md.
  "agent-prompt"() {
    // Without SITE_URL, copy.js fills in the origin the page is served from.
    const origin = siteUrl ? escapeHtml(siteUrl) : '<span data-origin>https://&lt;docs site&gt;</span>';
    const text = escapeHtml(agentPrompt.trim()).replaceAll("{{origin}}", origin);
    return (
      `<section class="agent-prompt" aria-label="Prompt for your coding agent">` +
      `<figure class="code prompt"><figcaption>Prompt for your coding agent</figcaption>` +
      `<pre class="lang-text" data-lang="text"><code>${text}</code></pre></figure>` +
      `<p class="agent-prompt-note">Paste it into Claude Code, Cursor, Codex, or any agent that can run commands in your project. It is also at <a href="agent-prompt.txt">agent-prompt.txt</a>, and the docs for agents are in <a href="llms.txt">llms.txt</a>.</p>` +
      `</section>`
    );
  },
  // The checkout-to-entitlements sequence on the home page.
  flow() {
    const lanes = [
      ["Browser", "the buyer"],
      ["Your space", "Zero capsule or Functions worker"],
      ["Polar", "api.polar.sh"],
    ];
    const laneName = (k) => (k === 2 ? "your space" : lanes[k - 1][0]);
    // [from lane, to lane, label html, note, kind]
    const steps = [
      [1, 2, inlineCode("GET /api/polar/checkout"), "The buyer clicks Upgrade."],
      [2, 3, inlineCode("POST /v1/checkouts/"), "With <code>external_customer_id</code> set to your user id."],
      [2, 1, "<code>302</code> to the Polar checkout", ""],
      [1, 3, "The buyer pays", ""],
      [3, 2, inlineCode("POST /api/polar/webhooks"), "<code>customer.state_changed</code>, signed.", "hook"],
      [2, 2, "Entitlements snapshot saved", "In the space database, keyed by your user id.", "store"],
      [2, 2, '<code>hasActiveSubscription(entitlements, "prod_…")</code>', "Your code reads it locally. No call to Polar.", "read"],
    ];
    const head = lanes
      .map(([name, sub]) => `<div class="lane"><span class="lane-name">${name}</span><span class="lane-sub">${sub}</span></div>`)
      .join("");
    const rows = steps
      .map(([from, to, label, note, kind = ""], index) => {
        const self = from === to;
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        const columns = self ? `${2 * from - 1} / ${2 * from + 2}` : `${2 * lo} / ${2 * hi}`;
        const direction = self ? "self" : from < to ? "ltr" : "rtl";
        const route = self ? `In ${laneName(from)}` : `${lanes[from - 1][0]} to ${laneName(to)}`;
        return (
          `<li class="step step-${direction}${kind ? ` step-${kind}` : ""}" style="--cols: ${columns}">` +
          `<span class="step-n">${index + 1}</span>` +
          `<div class="msg"><span class="msg-route">${route}</span><span class="msg-label">${label}</span>${note ? `<span class="msg-note">${note}</span>` : ""}</div>` +
          `</li>`
        );
      })
      .join("\n");
    return (
      `<figure class="flow" aria-label="How a purchase reaches your code">` +
      `<div class="flow-head">${head}</div>` +
      `<ol class="flow-body">\n${rows}\n</ol>` +
      `</figure>`
    );
  },
};

// ---------------------------------------------------------------------------
// Layout

function sidebar(current) {
  return NAV.map(
    ({ group, pages }) =>
      `<div class="nav-group"><p class="nav-label">${group}</p><ul>` +
      pages
        .map(
          ([slug, label]) =>
            `<li><a href="${href(slug)}"${slug === current ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a></li>`,
        )
        .join("") +
      `</ul></div>`,
  ).join("");
}

function layout({ slug, title, description, lead, content, toc, meta }) {
  const index = ORDER.findIndex((page) => page.slug === slug);
  const prev = ORDER[index - 1];
  const next = ORDER[index + 1];
  const isHome = slug === "index";
  const pageTitle = isHome ? `spacefast-polar: ${title}` : `${title} | spacefast-polar`;
  const pager =
    `<nav class="pager" aria-label="Previous and next page">` +
    (prev ? `<a class="pager-prev" href="${href(prev.slug)}"><span>Previous</span>${escapeHtml(prev.label)}</a>` : "<span></span>") +
    (next ? `<a class="pager-next" href="${href(next.slug)}"><span>Next</span>${escapeHtml(next.label)}</a>` : "<span></span>") +
    `</nav>`;
  const tocHtml =
    toc.length > 1
      ? `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${toc
          .map((item) => `<li><a href="#${item.id}">${item.html.replace(/<\/?a[^>]*>/g, "")}</a></li>`)
          .join("")}</ul></nav>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(pageTitle)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(pageTitle)}">
<meta property="og:description" content="${escapeHtml(description)}">
<link rel="alternate" type="text/markdown" href="${slug}.md.txt">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="style.css">
</head>
<body class="${isHome ? "page-home" : `page-${slug}`}">
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
  <a class="brand" href="index.html"><img src="icon.svg" alt="" width="28" height="28"><span>spacefast-polar</span></a>
  <span class="topbar-meta">v${escapeHtml(meta.version)}, Polar API <code>${escapeHtml(meta.apiVersion)}</code></span>
  <nav class="topbar-links" aria-label="External">
    <a href="https://polar.sh/docs" rel="noopener">Polar docs</a>
    <a href="https://spacefast.com" rel="noopener">Spacefast</a>
    ${meta.repo ? `<a href="${escapeHtml(meta.repo)}" rel="noopener">Source</a>` : ""}
  </nav>
</header>
<details class="mobile-nav"><summary>Menu<span class="mobile-current">${escapeHtml(ORDER[index].label)}</span></summary><nav aria-label="Documentation">${sidebar(slug)}</nav></details>
<div class="shell">
  <aside class="sidebar"><nav aria-label="Documentation">${sidebar(slug)}</nav></aside>
  <main id="content" class="content">
    <article>
      <header class="page-head">
        <h1>${inline(title)}</h1>
        ${lead ? `<p class="lead">${inline(lead)}</p>` : ""}
      </header>
${content}
    </article>
    ${pager}
    <footer class="footer"><p>spacefast-polar ${escapeHtml(meta.version)}. Requests are pinned to Polar API version <code>${escapeHtml(meta.apiVersion)}</code>.</p><p>For agents: <a href="${slug}.md.txt">this page as Markdown</a> · <a href="llms.txt">llms.txt</a> · <a href="llms-full.txt">llms-full.txt</a></p></footer>
  </main>
  ${tocHtml}
</div>
<script src="copy.js" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Markdown for agents

const FLOW_TEXT = `1. The buyer opens \`GET /api/polar/checkout\` on your space.
2. Your space creates a Polar checkout with \`external_customer_id\` set to your user id, and redirects to it.
3. The buyer pays on Polar.
4. Polar sends a signed \`customer.state_changed\` webhook to \`POST /api/polar/webhooks\`. The adapter verifies it and saves an entitlements snapshot in the space database, keyed by your user id.
5. Your code calls \`hasActiveSubscription(entitlements, "prod_…")\` on the stored snapshot. No call to Polar.`;

const absolute = (path) => (siteUrl ? `${siteUrl}/${path}` : path);

/** One page as standalone Markdown: headings without {#ids}, components as text, links to .md. */
function pageMarkdown(data, body) {
  const out = body
    .replace(/^(#{2,4}\s+.*?)\s+\{#[\w-]+\}\s*$/gm, "$1")
    .replace(/^<!--\s*flow\s*-->$/m, FLOW_TEXT)
    .replace(/^<!--\s*agent-prompt\s*-->$/m, () => "````text\n" + promptText() + "\n````")
    .replace(/^<dl[^>]*>$|^<\/dl>$/gm, "")
    .replace(/^<div><dt>(.*?)<\/dt><dd>(.*?)<\/dd><\/div>$/gm, "- **$1**: $2")
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(/\]\((?!https?:|#|mailto:)([\w-]+)\.html/g, "]($1.md.txt")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lead = data.lead ? `${data.lead}\n\n` : "";
  return `# ${data.title}\n\n> ${data.description}\n\n${lead}${out}\n`;
}

function promptText() {
  return agentPrompt.trim().replaceAll("{{origin}}", siteUrl || "<docs site>");
}

function llmsIndex(pages, meta) {
  const groups = NAV.map(({ group, pages: entries }) => {
    const lines = entries.map(([slug]) => {
      const page = pages.find((item) => item.slug === slug);
      return `- [${page.title}](${absolute(`${slug}.md.txt`)}): ${page.description}`;
    });
    return `## ${group}\n\n${lines.join("\n")}`;
  });
  return `# spacefast-polar

> Polar payments, subscriptions, and webhooks for Spacefast spaces, on both Zero capsules and Functions workers. Checkout and customer-portal redirect endpoints, verified webhooks, entitlements stored in the space's own database, and a typed Polar API client. No runtime dependencies. Version ${meta.version}, pinned to Polar API ${meta.apiVersion}.

Things agents get wrong:

- Zero server code cannot import npm packages. Run \`npx spacefast-polar add zero\` to copy the adapter into \`server/polar/\` and import \`./polar/index.ts\`. Write the \`polarEntitlements\` and \`polarWebhookDeliveries\` tables out in \`server/index.ts\`, because Zero reads the schema from that file's source.
- Functions workers install from npm: \`npm install spacefast-polar\`, import \`spacefast-polar/functions\` for routes and \`spacefast-polar\` for the client and helpers.
- The buyer's id comes from your server-side auth, never from the query string. \`?metadata=\` is ignored unless \`queryMetadata: true\`; use \`prepare\` for server-decided products, prices, and metadata.
- Secrets are server-only: \`sf env set POLAR_ACCESS_TOKEN --value-from-stdin\`, \`sf env set POLAR_WEBHOOK_SECRET --value-from-stdin\`, \`sf env set POLAR_SERVER sandbox --no-secret\`.
- Polar must reach the webhook: make \`/api/polar/webhooks\` public with \`sf share grant --to public --role viewer --path /api/polar/webhooks\`, use the raw format, and subscribe to \`customer.state_changed\`.

${groups.join("\n\n")}

## Optional

- [Full documentation in one file](${absolute("llms-full.txt")})
- [Setup prompt for coding agents](${absolute("agent-prompt.txt")})
`;
}

// ---------------------------------------------------------------------------
// Build

async function build() {
  const pkg = JSON.parse(await readFile(join(repoDir, "package.json"), "utf8"));
  const generated = await readFile(join(repoDir, "src/core/generated.ts"), "utf8");
  const apiVersion = /POLAR_API_VERSION = "([^"]+)"/.exec(generated)?.[1] ?? "unknown";
  const repo = String(pkg.repository?.url ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  const meta = { version: pkg.version, apiVersion, repo };

  agentPrompt = await readFile(join(siteDir, "agent-prompt.md"), "utf8");
  const homepage = /^https?:\/\//.test(pkg.homepage ?? "") && !/github\.com/.test(pkg.homepage) ? pkg.homepage : "";
  siteUrl = (process.env.SITE_URL ?? homepage).replace(/\/+$/, "");

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const written = [];
  const markdown = [];
  for (const { slug } of ORDER) {
    const source = await readFile(join(siteDir, "pages", `${slug}.md`), "utf8");
    const { data, body } = parseFrontMatter(source);
    if (!data.title || !data.description) throw new Error(`${slug}.md needs a title and a description`);
    const expanded = body.replaceAll("{{version}}", meta.version).replaceAll("{{apiVersion}}", meta.apiVersion);
    const state = { ids: new Set(["content"]), toc: [] };
    const content = renderMarkdown(expanded, state, components);
    const html = layout({ slug, title: data.title, description: data.description, lead: data.lead, content, toc: state.toc, meta });
    await writeFile(join(outDir, href(slug)), html);
    const md = pageMarkdown(data, expanded);
    await writeFile(join(outDir, `${slug}.md.txt`), md);
    markdown.push({ slug, title: data.title, description: data.description, md });
    written.push(href(slug));
  }

  await writeFile(join(outDir, "llms.txt"), llmsIndex(markdown, meta));
  await writeFile(
    join(outDir, "llms-full.txt"),
    `# spacefast-polar documentation\n\nVersion ${meta.version}, Polar API ${meta.apiVersion}. Every page of the docs, in order.\n\n` +
      markdown.map((page) => page.md.replace(/^# /, "# Page: ")).join("\n---\n\n"),
  );
  await writeFile(join(outDir, "agent-prompt.txt"), `${promptText()}\n`);

  await copyFile(join(siteDir, "style.css"), join(outDir, "style.css"));
  await copyFile(join(siteDir, "copy.js"), join(outDir, "copy.js"));
  await copyFile(join(repoDir, "assets/icon.svg"), join(outDir, "icon.svg"));
  await copyFile(join(siteDir, "sf.jsonc"), join(outDir, "sf.jsonc"));

  console.log(`Built ${written.length} pages into ${outDir}`);
  for (const file of written) console.log(`  ${file}`);
  console.log("  plus a .md.txt copy of each page, llms.txt, llms-full.txt, and agent-prompt.txt");
}

await build();
