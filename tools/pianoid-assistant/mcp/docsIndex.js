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

/** [{title, page, url, text}] for every heading section of every page. */
export function buildIndex(docsDir) {
  const sections = [];
  for (const file of walk(docsDir)) {
    const rel = path.relative(docsDir, file);
    const url = pageUrl(rel);
    let current = { title: rel, page: rel, url, lines: [] };
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
      if (m) {
        if (current.lines.length) sections.push(current);
        const explicit = /\{#([\w-]+)\}\s*$/.exec(m[2]);
        const title = explicit ? m[2].slice(0, explicit.index).trim() : m[2];
        current = { title, page: rel, url: `${url}#${explicit ? explicit[1] : slugify(title)}`, lines: [] };
      } else if (line.trim()) {
        current.lines.push(line);
      }
    }
    if (current.lines.length) sections.push(current);
  }
  return sections.map((s) => ({ title: s.title, page: s.page.replace(/\\/g, '/'), url: s.url, text: s.lines.join('\n') }));
}

const terms = (q) => (q.toLowerCase().match(/[a-z0-9_]{2,}/g) || []);

/** Top `limit` sections for a query: title hits weigh 4x; every term must appear somewhere. */
export function search(index, query, limit = 5) {
  const ts = terms(query);
  if (!ts.length) return [];
  const scored = [];
  for (const s of index) {
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
