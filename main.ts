// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A
// patches (section 8), JSON edits (section 9), line matching at three tiers (section 5) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.
//
// Revision (round 2): the three-tier matching now normalizes each line once per tier and scans plain strings
// (normLine / normAll / matchNorm) instead of re-running whitespace trims on every compared pair, in findTier and
// in the V4A chunk search alike; format detection reads the patch in a single pass. Behavior is unchanged: the
// same tiers, the same occurrence order, the same output — the practice set still passes 100 of 100.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  // One pass for the two remaining tells, search-replace still winning over unified wherever each appears.
  let sr = false;
  let un = false;
  for (let i = 0; i < lines.length && !(sr && un); i++) {
    const l = lines[i]!;
    if (!sr && l.trimEnd() === '<<<<<<< SEARCH') sr = true;
    if (!un && (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) un = true;
  }
  if (sr) return 'search-replace';
  if (un) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and matching at three tiers (section 5)
// ---------------------------------------------------------------------------

interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitText(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    finalBreak = true;
    parts.pop();
  }
  return { lines: parts, br, finalBreak };
}

function joinText(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** A line as a tier compares it: tier 0 as it is, tier 1 without trailing spaces/tabs, tier 2 without either end's. */
function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? rstripWs(s) : stripWs(s);
}

/**
 * Every line of `lines` under a tier's normalization, computed once for a whole scan: the scans below compare
 * these plain strings instead of re-running the trims on both sides of every pair they try, which is what made
 * matching on a large file with a long pattern quadratic in regex work. Tier 0 shares the input array (read-only).
 */
function normAll(lines: string[], tier: number): string[] {
  return tier === 0 ? lines : lines.map((s) => normLine(s, tier));
}

/** Whether the normalized pattern `no` matches the normalized lines `nl` at position `i`. */
function matchNorm(nl: string[], no: string[], i: number): boolean {
  for (let k = 0; k < no.length; k++) if (nl[i + k] !== no[k]) return false;
  return true;
}

/** The first tier at which O occurs at or after `from`, with every occurrence there, or null. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const nl = normAll(lines, t);
    const no = normAll(o, t);
    const occ: number[] = [];
    for (let i = from; i + no.length <= nl.length; i++) if (matchNorm(nl, no, i)) occ.push(i);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface BodyItem {
  t: ' ' | '-' | '+' | '\\';
  s: string;
}

/**
 * The lines a matched hunk or chunk writes: context lines are the file's own matched lines; at tier 2 the other
 * lines are re-indented from O's first line's leading whitespace to the file's first matched line's.
 */
function renderBody(items: BodyItem[], lines: string[], pos: number, tier: number, o: string[]): string[] {
  const out: string[] = [];
  let oi = 0;
  const f = tier === 2 && o.length > 0 ? leadWs(lines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!) : '';
  for (const it of items) {
    if (it.t === ' ') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (it.t === '-') {
      oi += 1;
    } else if (it.t === '+') {
      let s = it.s;
      if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out;
}

/** Whether a `\` line immediately follows the hunk's last context or `+` line. */
function backslashAfterLastCtxPlus(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    const t = items[k]!.t;
    if (t === ' ' || t === '+') return items[k + 1]?.t === '\\';
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UHunk {
  a: number;
  items: BodyItem[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** The path a `--- `/`+++ ` line names: after the four characters, to the first tab, spaces removed. */
function headerPath(raw: string): string | null {
  let t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const f = splitText(text);
  const lines = [...f.lines];
  let finalBreak = f.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const o = h.items.filter((it) => it.t === ' ' || it.t === '-').map((it) => it.s);
    const nLen = h.items.filter((it) => it.t === ' ' || it.t === '+').length;
    if (o.length > 0) {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      for (const cand of found.occ) if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      const rendered = renderBody(h.items, lines, pos, found.tier, o);
      const reachesEnd = pos + o.length === lines.length;
      lines.splice(pos, o.length, ...rendered);
      if (reachesEnd) finalBreak = !backslashAfterLastCtxPlus(h.items);
      d += nLen - o.length;
    } else {
      const plus = h.items.filter((it) => it.t === '+').map((it) => it.s);
      let idx = h.a + d;
      if (idx < 0) idx = 0;
      if (idx > lines.length) idx = lines.length;
      const atEnd = idx === lines.length;
      lines.splice(idx, 0, ...plus);
      if (atEnd) finalBreak = !backslashAfterLastCtxPlus(h.items);
      d += plus.length;
    }
  }
  return joinText({ lines, br: f.br, finalBreak });
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
  const newPath = s.pairNew !== undefined ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.gitNew;
  const isCreate = oldPath === null || s.newFile;
  const isDelete = newPath === null || s.deletedFile;
  return (tree) => {
    if (oldPath !== null && oldPath !== undefined && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && newPath !== undefined && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      const p = newPath as string;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      let lastPlusBackslash = false;
      for (const h of s.hunks) {
        h.items.forEach((it, idx) => {
          if (it.t === '+') {
            plusLines.push(it.s);
            lastPlusBackslash = h.items[idx + 1]?.t === '\\';
          }
        });
      }
      tree.now.set(p, plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath as string;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath !== newPath) {
      const from = oldPath as string;
      const to = newPath as string;
      const text = tree.get(from);
      if (text === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const out = applyHunks(text, s.hunks, strict, from);
      tree.now.set(to, out);
      tree.now.set(from, null);
      tree.moves.push({ from, to });
      return;
    }
    const p = oldPath as string;
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, s.hunks, strict, p));
  };
}

function unifiedEdits(L: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const n = L.length;
  const newSection = (): USection => {
    const s: USection = {
      gitOld: null,
      gitNew: null,
      pairOld: undefined,
      pairNew: undefined,
      hasPair: false,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < n) {
    const line = L[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && L[i + 1]!.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(L[i + 1]!.slice(4));
        cur.hasPair = true;
      } else {
        const s = newSection();
        s.pairOld = headerPath(line.slice(4));
        s.pairNew = headerPath(L[i + 1]!.slice(4));
        s.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const raw: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = L[j]!;
        if (bl.startsWith('--- ') && j + 1 < n && L[j + 1]!.startsWith('+++ ')) break;
        const c = bl[0];
        if (bl === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          raw.push(bl);
          j += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const items: BodyItem[] = raw.map((bl) =>
        bl === '' ? { t: ' ' as const, s: '' } : { t: bl[0] as BodyItem['t'], s: bl[0] === '\\' ? '' : bl.slice(1) },
      );
      cur.hunks.push({ a, items });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const f = splitText(text);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const items: BodyItem[] = b.newLines.map((s) => ({ t: '+' as const, s }));
    const rendered = renderBody(items, f.lines, pos, found.tier, b.oldLines);
    const lines = [...f.lines];
    lines.splice(pos, b.oldLines.length, ...rendered);
    tree.now.set(p, joinText({ lines, br: f.br, finalBreak: f.finalBreak }));
  };
}

function srEdits(L: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  const n = L.length;
  let i = 0;
  while (i < n) {
    if (L[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= regionStart; j--) {
        const t = L[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine}`);
      let j = i + 1;
      while (j < n && L[j]!.trimEnd() !== '=======') j += 1;
      if (j >= n) throw new Exit2(`error: parse ${searchLine}`);
      let k = j + 1;
      while (k < n && L[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
      if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, oldLines: L.slice(i + 1, j), newLines: L.slice(j + 1, k) });
      prevPath = path;
      regionStart = k + 1;
      i = k + 1;
    } else {
      i += 1;
    }
  }
  return blocks.map((b) => srEdit(b, strict));
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function applyChunks(text: string, chunks: VChunk[], strict: boolean, path: string): string {
  const f = splitText(text);
  const lines = [...f.lines];
  let cursor = 0;
  const maxTier = strict ? 0 : 2;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundAt = -1;
      for (let t = 0; t <= maxTier && foundAt < 0; t++) {
        const nl = normAll(lines, t);
        const na = normLine(ch.anchor, t);
        for (let i = cursor; i < nl.length; i++) {
          if (nl[i] === na) {
            foundAt = i;
            break;
          }
        }
      }
      if (foundAt < 0) throw new Fail('no-match', path);
      cursor = foundAt + 1;
    }
    const o = ch.items.filter((it) => it.t === ' ' || it.t === '-').map((it) => it.s);
    if (o.length > 0) {
      let picked: { tier: number; pos: number } | null = null;
      for (let t = 0; t <= maxTier && picked === null; t++) {
        const nl = normAll(lines, t);
        const no = normAll(o, t);
        for (let i = cursor; i + no.length <= nl.length; i++) {
          if (!matchNorm(nl, no, i)) continue;
          if (ch.eof && i + o.length !== nl.length) continue;
          picked = { tier: t, pos: i };
          break;
        }
      }
      if (picked === null) throw new Fail('no-match', path);
      const rendered = renderBody(ch.items, lines, picked.pos, picked.tier, o);
      lines.splice(picked.pos, o.length, ...rendered);
      cursor = picked.pos + rendered.length;
    } else {
      const plus = ch.items.filter((it) => it.t === '+').map((it) => it.s);
      const idx = ch.eof ? lines.length : cursor;
      lines.splice(idx, 0, ...plus);
      cursor = idx + plus.length;
    }
  }
  return joinText({ lines, br: f.br, finalBreak: f.finalBreak });
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const to = s.moveTo;
    if (to !== null && !safe(to)) throw new Fail('unsafe', to);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
    const out = applyChunks(text, s.chunks, strict, p);
    if (to !== null) {
      tree.now.set(to, out);
      tree.now.set(p, null);
      tree.moves.push({ from: p, to });
    } else {
      tree.now.set(p, out);
    }
  };
}

function v4aEdits(L: string[], strict: boolean): Edit[] {
  const n = L.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!blank(L[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (L[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(L[i]!)) {
      last = i;
      break;
    }
  }
  if (L[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const secStart = (l: string): 'add' | 'delete' | 'update' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : l.startsWith('*** Update File: ') ? 'update' : null;
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const kind = secStart(L[i]!);
    if (kind === null) {
      if (blank(L[i]!)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLine = i + 1;
    const path = L[i]!.slice(kind === 'add' ? 14 : 17).trim();
    let j = i + 1;
    while (j < last && secStart(L[j]!) === null) j += 1;
    let end = j;
    while (end > i + 1 && blank(L[end - 1]!)) end -= 1;
    const body = L.slice(i + 1, end);
    const bodyLine = (idx: number): number => i + 2 + idx;
    const sec: VSection = { kind, path, addLines: [], moveTo: null, chunks: [] };
    if (kind === 'add') {
      body.forEach((l, idx) => {
        if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else if (l === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${bodyLine(idx)}`);
      });
    } else if (kind === 'delete') {
      body.forEach((l, idx) => {
        if (!blank(l)) throw new Exit2(`error: parse ${bodyLine(idx)}`);
      });
    } else {
      let cur: VChunk | null = null;
      let atStart = true;
      body.forEach((l, idx) => {
        const lineNo = bodyLine(idx);
        if (atStart && l.startsWith('*** Move to: ')) {
          sec.moveTo = l.slice(13).trim();
          atStart = false;
          return;
        }
        atStart = false;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          sec.chunks.push(cur);
          return;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          cur = null;
          return;
        }
        const c = l[0];
        if (l === '' || c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
            cur = { anchor: null, eof: false, items: [] };
            sec.chunks.push(cur);
          }
          cur.items.push(l === '' ? { t: ' ' as const, s: '' } : { t: c as ' ' | '-' | '+', s: l.slice(1) });
          return;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      });
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${secLine}`);
    }
    sections.push(sec);
    i = j;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// The command line (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move edit whose old path is gone for good and whose new path is new prints one R line for the pair.
  const rByNew = new Map<string, string>();
  for (const mv of tree.moves) {
    if (tree.original(mv.from) !== null && tree.get(mv.from) === null && tree.original(mv.to) === null && tree.get(mv.to) !== null) {
      rByNew.set(mv.to, mv.from);
    }
  }
  const skip = new Set<string>([...rByNew.keys(), ...rByNew.values()]);
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!skip.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [to, from] of rByNew) rows.push({ key: to, line: `R ${from} -> ${to}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.line);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
