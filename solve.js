// swift-site: a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns the same output tree makefun-site 1.0.0 returns for
// one generated site { site, templates, files }: every page's index.html,
// the index and tag pages, build-report.txt and each static file, byte for
// byte. It is a fresh implementation of the dialect the reference states
// (front matter, template dialect, Markdown subset, slug rule, report):
// no code is shared with the reference. Where it is faster is the shape:
// Markdown renders in one left-to-right scan per block with no token tree
// and no substring copies, templates compile once per name into flat
// instruction lists with pre-resolved variable accessors, slugs are
// cached, and the whole build runs as one fused pass that reuses its
// cards, tags and neighbour links instead of rebuilding them per render.
// It reads no clock, no environment, no randomness and no file: its output
// is a function of its input alone.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `text` with & < > " and ' escaped; the input itself when it holds none. */
function esc(text) {
  if (!/[&<>"']/.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += text.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? text : out + text.slice(start);
}

const SLUG_MAX = 64;
const slugCache = new Map();

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every
 *  run of characters other than a-z and 0-9 one "-", none at either end,
 *  at most 64 characters (a "-" left at the cut dropped), "untitled" when
 *  nothing is left. Pure ASCII text skips normalisation: it is its own
 *  NFKD and holds no combining mark. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  if (/[^\x00-\x7F]/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = null;
    if (c >= 65 && c <= 90) keep = plain[i].toLowerCase();
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = plain[i];
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  let end = out.length > SLUG_MAX ? SLUG_MAX : out.length;
  while (end > 0 && out[end - 1] === '-') end--;
  const slug = end === 0 ? 'untitled' : out.slice(0, end);
  slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEY_SET = new Set(KEYS);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringVal(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringVal(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        if (tags[i] === '' || /["[\]]/.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return /^[a-z0-9-]+$/.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  const data = {};
  let lineStart = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 1;
  for (;;) {
    const eol = text.indexOf('\n', lineStart);
    const line = eol === -1 ? text.slice(lineStart) : text.slice(lineStart, eol);
    lineNo++;
    if (line === '---') {
      if (!('title' in data)) return { error: 'no title' };
      return { data, body: eol === -1 ? '' : text.slice(eol + 1) };
    }
    if (line.length === 0 || /^[ \t]*$/.test(line) || line[0] === '#') {
      // blank or a comment: nothing to check
    } else {
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || line[k] === '_')) break;
        k++;
      }
      if (k === 0 || k >= line.length || line[k] !== ':') return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k === line.length - 1) raw = '';
      else if (line[k + 1] === ' ') raw = line.slice(k + 2).replace(/[ \t]+$/, '');
      else return { error: `line ${lineNo} is not "key: value"` };
      if (!KEY_SET.has(key)) return { error: `unknown key "${key}"` };
      if (key in data) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (eol === -1) return { error: 'the front matter is not closed' };
    lineStart = eol + 1;
  }
}

// ---------------------------------------------------------------- markdown

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A fence's language, or null when the line opens no fence. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    j++;
  }
  const langEnd = j;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length ? line.slice(3, langEnd) : null;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (line[n] !== ' ' && line[n] !== '\t') return null;
  let j = n;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  let end = line.length;
  while (end > j && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end === j) return null;
  return { depth: n, text: line.slice(j, end) };
}

/** Whether `line` is a thematic break: --- or ***, spaces or tabs after. */
function isHR(line) {
  const c = line[0];
  if (c !== '-' && c !== '*') return false;
  if (line[1] !== c || line[2] !== c) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A bullet item's text, or null: "- " or "* " and the rest. */
function bulletOf(line) {
  const c = line[0];
  if ((c === '-' || c === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item's text and start number, or null: digits and ". ". */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { text: line.slice(j + 2), start: Number(line.slice(0, j)) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  for (let j = 2; j < line.length; j++) {
    const c = line[j];
    if (c === ' ') continue;
    return c !== '\t';
  }
  return false;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` (up to `end`) where `s` holds `what` outside
 *  a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  for (let j = from; j + what.length <= end; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an
 *  escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Push the escaped plain run s[seg..i) onto `out` when it is not empty. */
function flushPlain(s, seg, i, out) {
  if (i > seg) out.push(esc(s.slice(seg, i)));
}

/** `s[a..b)` rendered inline into `out`; `link(target)` is a link's href. */
function inlineInto(s, a, b, link, out) {
  let i = a;
  let seg = a;
  while (i < b) {
    const c = s[i];
    if (c === '\\' && i + 1 < b && ESCAPABLE.has(s[i + 1])) {
      flushPlain(s, seg, i, out);
      out.push(esc(s[i + 1]));
      i += 2;
      seg = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        flushPlain(s, seg, i, out);
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        seg = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          flushPlain(s, seg, i, out);
          out.push('<strong>');
          inlineInto(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          seg = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        flushPlain(s, seg, i, out);
        out.push('<em>');
        inlineInto(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
        seg = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s[k + 1] === '(') {
        const r = s.indexOf(')', k + 2);
        if (r !== -1 && r < b) m = r;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flushPlain(s, seg, i, out);
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(s, i + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
        seg = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flushPlain(s, seg, b, out);
}

/** `src` rendered: its HTML, its table of contents (level 2 and 3
 *  headings) and its excerpt (the first paragraph's inline HTML). */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = '<pre><code';
      if (lang !== '') code += ` class="language-${esc(lang)}"`;
      code += '>';
      for (let k = 0; k < body.length; k++) code += esc(body[k]) + '\n';
      blocks.push(code + '</code></pre>\n');
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text), ids);
      const out = [];
      inlineInto(h.text, 0, h.text.length, link, out);
      const html = out.join('');
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) {
        blocks.push('<blockquote>\n</blockquote>\n');
      } else {
        const out = [];
        const joined = kept.join('\n');
        inlineInto(joined, 0, joined.length, link, out);
        blocks.push(`<blockquote>\n<p>${out.join('')}</p>\n</blockquote>\n`);
      }
      continue;
    }
    const b0 = bulletOf(line);
    const o0 = b0 === null ? orderedOf(line) : null;
    if (b0 !== null || o0 !== null) {
      const isOrd = o0 !== null;
      const items = [];
      while (i < n) {
        const m = isOrd ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrd ? m.text : m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      let html = isOrd && o0.start !== 1 ? `<ol start="${o0.start}">\n` : `<${tag}>\n`;
      for (let k = 0; k < items.length; k++) {
        const joined = items[k].join('\n');
        const out = [];
        inlineInto(joined, 0, joined.length, link, out);
        html += `<li>${out.join('')}</li>\n`;
      }
      blocks.push(`${html}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const out = [];
    inlineInto(text, 0, text.length, link, out);
    const html = out.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's
 *  line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- compilation: a parsed template becomes flat ops with accessors
// resolved against the loops that enclose each node. A loop frame sits in
// the frame array at base + its depth among the template's enclosing
// loops; the root vars are frames[0]. An included template renders with
// base = the frame count at the include, so its own loops stack above the
// caller's frames.

const hasOwn = Object.prototype.hasOwnProperty;

/** A getter for `path`: its first name from the frame it is bound in,
 *  then own properties down. A name bound by one of this template's own
 *  loops reads that loop's frame directly; any other name is read from the
 *  nearest frame holding it, walking the frame stack from the top down —
 *  that is how a name bound by a caller's loop reaches an included
 *  template, and how the root vars are found. */
function makeGetter(path, frame) {
  if (frame >= 0) {
    if (path.length === 1) {
      return (frames, base) => frames[base + frame][path[0]];
    }
    return (frames, base) => {
      let v = frames[base + frame][path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !hasOwn.call(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    };
  }
  if (path.length === 1) {
    return (frames) => {
      for (let f = frames.length - 1; f >= 0; f--) {
        if (hasOwn.call(frames[f], path[0])) return frames[f][path[0]];
      }
      return undefined;
    };
  }
  return (frames) => {
    let v;
    for (let f = frames.length - 1; f >= 0; f--) {
      if (hasOwn.call(frames[f], path[0])) {
        v = frames[f][path[0]];
        break;
      }
    }
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !hasOwn.call(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  };
}

/** Which frame binds `first`: the depth of the innermost enclosing loop
 *  that binds it, or -1 for the root vars. `loops` holds the names bound
 *  by the enclosing loops, outermost first. */
function bindFrame(first, loops) {
  for (let d = loops.length - 1; d >= 0; d--) {
    if (loops[d] === first) return d;
  }
  return -1;
}

/** Compile parsed nodes into ops, with `loops` the names bound by the
 *  enclosing loops, outermost first. */
function compileNodes(nodes, loops) {
  const ops = [];
  for (const n of nodes) {
    if (n.kind === 'text') ops.push({ t: 0, s: n.text });
    else if (n.kind === 'var' || n.kind === 'raw') {
      ops.push({ t: n.kind === 'var' ? 1 : 2, get: makeGetter(n.path, bindFrame(n.path[0], loops)) });
    } else if (n.kind === 'if') {
      const get = makeGetter(n.path, bindFrame(n.path[0], loops));
      const not = n.not;
      ops.push({
        t: 3,
        cond: (frames, base) => {
          const v = get(frames, base);
          const truth = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
          return truth !== not;
        },
        then: compileNodes(n.then, loops),
        els: n.else === null ? null : compileNodes(n.else, loops),
      });
    } else if (n.kind === 'for') {
      const get = makeGetter(n.path, bindFrame(n.path[0], loops));
      const next = loops.concat([n.name]);
      ops.push({ t: 4, name: n.name, get, body: compileNodes(n.body, next) });
    } else if (n.kind === 'include') {
      ops.push({ t: 5, name: n.name });
    }
  }
  return ops;
}

/** A value as text: a string itself, a number in JavaScript's digits,
 *  true or false, an array's items joined by ", ", anything else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Push a value as text, HTML-escaped when it is a string or an array
 *  (numbers and booleans hold no character that escapes). */
function pushEscaped(v, out) {
  if (typeof v === 'string') out.push(esc(v));
  else if (typeof v === 'number') out.push(String(v));
  else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
  else if (Array.isArray(v)) out.push(esc(textOf(v)));
}

/** Push a value as text, raw. */
function pushRaw(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number') out.push(String(v));
  else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
  else if (Array.isArray(v)) out.push(textOf(v));
}

/** Render compiled `ops` into `out`. `frames[0]` holds the root vars;
 *  loop frames sit at `base` and above. `templates` maps names to ops. */
function renderOps(ops, frames, base, out, templates, depth) {
  for (let k = 0; k < ops.length; k++) {
    const n = ops[k];
    if (n.t === 0) {
      out.push(n.s);
    } else if (n.t === 1) {
      pushEscaped(n.get(frames, base), out);
    } else if (n.t === 2) {
      pushRaw(n.get(frames, base), out);
    } else if (n.t === 3) {
      const branch = n.cond(frames, base) ? n.then : n.els;
      if (branch !== null) renderOps(branch, frames, base, out, templates, depth);
    } else if (n.t === 4) {
      const xs = n.get(frames, base);
      if (!Array.isArray(xs)) continue;
      for (let j = 0; j < xs.length; j++) {
        frames.push({ [n.name]: xs[j], loop: { index: j + 1, first: j === 0, last: j === xs.length - 1, length: xs.length } });
        renderOps(n.body, frames, base, out, templates, depth);
        frames.pop();
      }
    } else {
      const t = templates.get(n.name);
      if (t !== undefined && depth < 8) renderOps(t, frames, frames.length, out, templates, depth + 1);
    }
  }
}

// ------------------------------------------------------------------- build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a
 *  source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 160 || (c > 127 && /\s/.test(text[i]));
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, compileNodes(parseTemplate(name, input.templates[name]), []));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !('date' in s.data)) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url.
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's neighbours.
  const posts = [];
  for (let i = 0; i < sources.length; i++) if (sources[i].post) posts.push(sources[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags, grouped by slug, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const tags = s.data.tags ?? [];
    const out = [];
    for (let i = 0; i < tags.length; i++) {
      const slug = slugify(tags[i]);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(tags[i]);
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.post) continue;
    const names2 = ownTags(s);
    s.tagRefs = new Array(names2.length);
    for (let j = 0; j < names2.length; j++) {
      const slug = slugify(names2[j]);
      const t = bySlug.get(slug);
      s.tagRefs[j] = t !== undefined ? t : { name: names2[j], slug, url: '', posts: [] };
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages.
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) {
    const s = posts[i];
    cards.set(s, {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    });
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    const out = [];
    const frames = [{ site, tags: allTags, recent, ...vars }];
    renderOps(ops, frames, frames.length, out, templates, 0);
    return out.join('');
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const card = cards.get(s) ?? {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.post ? s.newer : null),
      older: linkOf(s.post ? s.older : null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pagesCount = 0;
  for (let i = 0; i < sources.length; i++) if (!sources[i].post) pagesCount++;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
