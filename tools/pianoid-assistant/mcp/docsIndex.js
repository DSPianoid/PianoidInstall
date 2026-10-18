/**
 * search_docs: a keyword index over the MkDocs sources (PianoidInstall docs/**\/*.md), split into
 * heading sections, built once at start. Results link to the served docs (http://localhost:8001,
 * MkDocs directory URLs + the python-markdown toc anchor).
 */
import fs from 'node:fs';
import path from 'node:path';

export const DOCS_URL = 'http://localhost:8001';

export const slugify = (text) => text
  .normalize('NFKD').replace(/[^\x00-\x7F]/g, '')
  .replace(/[^\w\s-]/g, '').trim().toLowerCase()
  .replace(/[-\s]+/g, '-');

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'archive' || e.name === 'logs') continue;     // history, not reference
      walk(p, out);
    } else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
};

export const pageUrl = (rel) => {
  const noExt = rel.replace(/\\/g, '/').replace(/\.md$/, '');
  if (noExt === 'index') return `${DOCS_URL}/`;
  return `${DOCS_URL}/${noExt.replace(/\/index$/, '')}/`;
};

/**
 * [{title, page, url, anchor, level, text}] for every heading section of every page, in page order. A heading
 * with no body of its own is kept (text ''): read_docs needs it as the parent of its subsections. `anchor` =
 * the explicit `{#id}` (attr_list) or the toc slug; level 0 = the text before the first heading.
 */
export function buildIndex(docsDir) {
  const sections = [];
  for (const file of walk(docsDir)) {
    const rel = path.relative(docsDir, file);
    const url = pageUrl(rel);
    let current = { title: rel, page: rel, url, anchor: '', level: 0, lines: [] };
    let fence = false;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const m = !fence && /^(#{1,6})\s+(.*?)\s*$/.exec(line);
      if (m) {
        if (current.level || current.lines.length) sections.push(current);
        const explicit = /\{#([\w-]+)\}\s*$/.exec(m[2]);
        const title = explicit ? m[2].slice(0, explicit.index).trim() : m[2];
        const anchor = explicit ? explicit[1] : slugify(title);
        current = { title, page: rel, url: `${url}#${anchor}`, anchor, level: m[1].length, lines: [] };
      } else if (line.trim()) {
        current.lines.push(line);
      }
    }
    if (current.level || current.lines.length) sections.push(current);
  }
  return sections.map((s) => ({
    title: s.title, page: s.page.replace(/\\/g, '/'), url: s.url, anchor: s.anchor, level: s.level, text: s.lines.join('\n'),
  }));
}

const terms = (q) => (q.toLowerCase().match(/[a-z0-9_]{2,}/g) || []);

/** Top `limit` sections for a query: title hits weigh 4x; every term must appear somewhere. */
export function search(index, query, limit = 5) {
  const ts = terms(query);
  if (!ts.length) return [];
  const scored = [];
  for (const s of index) {
    if (!s.text) continue;
    const title = s.title.toLowerCase();
    const body = s.text.toLowerCase();
    let score = 0;
    let all = true;
    for (const t of ts) {
      const inTitle = title.split(t).length - 1;
      const inBody = body.split(t).length - 1;
      if (!inTitle && !inBody) { all = false; break; }
      score += 4 * inTitle + Math.min(inBody, 10);
    }
    if (all) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ s }) => {
    const body = s.text;
    const at = Math.max(0, body.toLowerCase().indexOf(ts[0]) - 120);
    return { title: s.title, page: s.page, url: s.url, snippet: body.slice(at, at + 600) };
  });
}

export const READ_LIMIT = 24000;      // characters per read_docs answer (about 6k tokens)

/** 'guides/X.md' | 'guides/X' | 'http://localhost:8001/guides/X/#a' -> {key, anchor}; key = the page without .md / index. */
export function pageKey(ref) {
  let r = String(ref || '').trim();
  let anchor = null;
  const hash = r.indexOf('#');
  if (hash >= 0) { anchor = r.slice(hash + 1) || null; r = r.slice(0, hash); }
  r = r.replace(DOCS_URL, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/^docs\//i, '')
    .replace(/\.md$/i, '').replace(/(^|\/)index$/i, '');
  return { key: r.toLowerCase(), anchor };
}

const heading = (s) => (s.level ? `${'#'.repeat(s.level)} ${s.title}\n` : '');

/**
 * read_docs: one whole section (the heading, its body and its subsections) of one page, or the page outline
 * when no anchor is given. Reads the index built from the docs folder only: no path from the model is opened.
 */
export function readSection(index, { page, anchor } = {}) {
  const ref = pageKey(page);
  const want = anchor || ref.anchor;
  const sections = index.filter((s) => pageKey(s.page).key === ref.key);
  if (!sections.length) {
    const words = ref.key.split(/[/_-]+/).filter((w) => w.length > 2);
    const pages = [...new Set(index.map((s) => s.page))].filter((p) => words.some((w) => p.toLowerCase().includes(w)));
    return { error: 'unknown_page', page, similar: pages.slice(0, 8) };
  }
  const outline = sections.filter((s) => s.level).map((s) => ({ level: s.level, title: s.title, anchor: s.anchor, url: s.url }));
  const first = sections[0];
  if (!want) return { page: first.page, url: pageUrl(first.page), outline, text: `${heading(first)}${first.text}`.slice(0, READ_LIMIT) };
  const at = sections.findIndex((s) => s.level && (s.anchor === want || slugify(s.title) === want));
  if (at < 0) return { error: 'unknown_anchor', page: first.page, anchor: want, outline };
  const top = sections[at];
  let end = at + 1;
  while (end < sections.length && sections[end].level > top.level) end += 1;
  const parts = [];
  const more = [];
  let size = 0;
  for (const s of sections.slice(at, end)) {
    const part = `${heading(s)}${s.text}\n`;
    if (more.length || (parts.length && size + part.length > READ_LIMIT)) { more.push(s.anchor); continue; }
    parts.push(part.slice(0, READ_LIMIT));
    size += part.length;
  }
  return { page: top.page, url: top.url, title: top.title, text: parts.join('\n'), ...(more.length ? { truncated: true, more_anchors: more } : {}) };
}
