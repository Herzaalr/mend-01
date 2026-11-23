// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file's lines under SPEC.md section 3: its own line break, its lines, whether it ends with one. */
function splitLines(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = parts[parts.length - 1] === '';
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** SPEC.md section 5: one line's key at a matching tier. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at one tier. */
function occurrencesAt(lines: string[], oldLines: string[], tier: number): number[] {
  const keys = oldLines.map((l) => tierKey(l, tier));
  const out: number[] = [];
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions (null when no tier has one). */
function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(lines, oldLines, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** The first tier at which one line occurs at or after `from`, with its first position (null when none). */
function findLineTier(lines: string[], line: string, from: number, strict: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierKey(lines[i]!, t) === tierKey(line, t)) return { tier: t, pos: i };
    }
  }
  return null;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/**
 * SPEC.md section 5: build N from a patch body's lines. `isCtx[j]` marks the j-th N line as a context line
 * (written as the file's own matched line, never the patch's); the other lines are re-indented at tier 2.
 * `oIndex[j]` is the O-index of the j-th N line when it is a context line.
 */
function buildNew(
  newLines: string[],
  oldLines: string[],
  fileLines: string[],
  pos: number,
  tier: number,
  isCtx: boolean[],
  oIndex: number[],
): string[] {
  if (tier !== 2) return newLines.map((l, j) => (isCtx[j] ? fileLines[pos + oIndex[j]!]! : l));
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(oldLines[0]!);
  return newLines.map((l, j) => {
    if (isCtx[j]) return fileLines[pos + oIndex[j]!]!;
    if (l !== '' && l.trim() !== '' && l.startsWith(p)) return f + l.slice(p.length);
    return l;
  });
}

/** Split one hunk/chunk body into O (context + `-` lines) and N (context + `+` lines), with context flags. */
function bodyParts(body: Array<{ kind: string; text: string }>): { O: string[]; N: string[]; isCtx: boolean[]; oIndex: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const isCtx: boolean[] = [];
  const oIndex: number[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      oIndex.push(O.length);
      isCtx.push(true);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      isCtx.push(false);
      oIndex.push(-1);
      N.push(b.text);
    }
  }
  return { O, N, isCtx, oIndex };
}

/** A `\` line follows the body's last context or `+` line (SPEC.md section 6, final-break rule). */
function backslashAfterLast(body: Array<{ kind: string; text: string }>): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) if (body[i]!.kind === ' ' || body[i]!.kind === '+') last = i;
  return last >= 0 && body[last + 1]?.kind === '\\';
}


/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a move edit performed: [old path, new path], in patch order. */
  readonly moves: Array<[string, string]> = [];
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
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

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

/* ---------------- SPEC.md section 6: unified diffs ---------------- */

interface Hunk {
  a: number;
  body: Array<{ kind: string; text: string }>;
}

interface UniSection {
  oldP: string | null;
  newP: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function uniPath(s: string): string {
  const t = s.slice(0, s.indexOf('\t') >= 0 ? s.indexOf('\t') : s.length).trim();
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

/** Apply one section's hunks to a file's split lines (SPEC.md section 6). */
function applyHunks(state: { br: string; lines: string[]; final: boolean }, hunks: Hunk[], strict: boolean, path: string): { br: string; lines: string[]; final: boolean } {
  let { br, lines, final } = state;
  let d = 0;
  for (const h of hunks) {
    const { O, N, isCtx, oIndex } = bodyParts(h.body);
    if (O.length === 0) {
      const pos = Math.min(h.a + d, lines.length);
      const atEnd = pos === lines.length;
      const out = [...lines.slice(0, pos), ...N, ...lines.slice(pos)];
      if (atEnd) final = !backslashAfterLast(h.body);
      lines = out;
      d += N.length;
      continue;
    }
    const found = findTier(lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    for (const q of found.positions) {
      if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
    }
    const endsAtEof = pos + O.length === lines.length;
    const N2 = buildNew(N, O, lines, pos, found.tier, isCtx, oIndex);
    lines = [...lines.slice(0, pos), ...N2, ...lines.slice(pos + O.length)];
    if (endsAtEof) final = !backslashAfterLast(h.body);
    d += N.length - O.length;
  }
  return { br, lines, final };
}

function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldP;
    const newP = s.newP;
    if (s.create) {
      if (newP === null) throw new Fail('missing', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      // The file ends with a line break unless a `\` line follows its last `+` line.
      let lastPlus: { h: number; i: number } | null = null;
      s.hunks.forEach((h, hi) => h.body.forEach((b, bi) => {
        if (b.kind === '+') lastPlus = { h: hi, i: bi };
      }));
      const fin = lastPlus === null || s.hunks[lastPlus.h]!.body[lastPlus.i + 1]?.kind !== '\\';
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (s.remove) {
      if (oldP === null) throw new Fail('missing', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const content = tree.get(oldP);
      if (content === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(splitLines(content), s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinLines(out.lines, out.br, out.final));
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const content = tree.get(oldP);
    if (content === null) throw new Fail('missing', oldP);
    const out = applyHunks(splitLines(content), s.hunks, strict, oldP);
    tree.now.set(oldP, joinLines(out.lines, out.br, out.final));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  while (i < lines.length) {
    const line = lines[i]!;
    let sec: UniSection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldP: m[1]!, newP: m[2]!, create: false, remove: false, hunks: [] };
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldP: null, newP: null, create: false, remove: false, hunks: [] };
    } else {
      // A hunk before any section is a parse error; every other line outside a section is ignored.
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    // header: until the first hunk, the next section, or the end. A `---`/`+++` pair belongs to
    // this section's header the first time one is seen; a second pair starts a new section.
    let hasHeaderPair = false;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (hasHeaderPair) break;
        sec.oldP = uniPath(l.slice(4));
        sec.newP = uniPath(lines[i + 1]!.slice(4));
        hasHeaderPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('--- ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) sec.oldP = l.slice(12).trim();
      else if (l.startsWith('rename to ')) sec.newP = l.slice(10).trim();
      else if (l.startsWith('new file mode')) sec.create = true;
      else if (l.startsWith('deleted file mode')) sec.remove = true;
      i++;
    }
    // hunks
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const m = hunkRe.exec(lines[i]!);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          hunk.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
          i++;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === ' ' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
      sec.hunks.push(hunk);
    }
    // a section with no header paths at all and no hunks is still one edit (a no-op change of nothing);
    // the diff --git paths cover it. A bare ---/+++ section always has both paths.
    if (sec.oldP === '/dev/null') sec.create = true;
    if (sec.newP === '/dev/null') sec.remove = true;
    sections.push(sec);
  }
  return sections.map((s) => uniSectionEdit(s, strict));
}

/* ---------------- SPEC.md section 7: SEARCH/REPLACE blocks ---------------- */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srBlockEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(b.path);
    if (content === null) throw new Fail('missing', b.path);
    const { br, lines, final } = splitLines(content);
    const found = findTier(lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const N2 = buildNew(b.newLines, b.oldLines, lines, pos, found.tier, b.newLines.map(() => false), b.newLines.map(() => -1));
    const out = [...lines.slice(0, pos), ...N2, ...lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, joinLines(out, br, final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let lastEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= lastEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const trimmed = t.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    lastEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => srBlockEdit(b, strict));
}

/* ---------------- SPEC.md section 8: V4A patches ---------------- */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ kind: string; text: string }>;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

function v4aSectionEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    // update
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const content = tree.get(s.path);
    if (content === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    let { br, lines, final } = splitLines(content);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const found = findLineTier(lines, chunk.anchor, cursor, strict);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found.pos + 1;
      }
      const { O, N, isCtx, oIndex } = bodyParts(chunk.body);
      if (O.length === 0) {
        const pos = chunk.eof ? lines.length : cursor;
        lines = [...lines.slice(0, pos), ...N, ...lines.slice(pos)];
        cursor = pos + N.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const occ = occurrencesAt(lines, O, t);
        const after = occ.filter((p) => p >= cursor);
        if (chunk.eof) {
          const eofPos = after.find((p) => p + O.length === lines.length);
          if (eofPos !== undefined) {
            found = { tier: t, pos: eofPos };
            break;
          }
        } else if (after.length > 0) {
          found = { tier: t, pos: after[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', s.path);
      const N2 = buildNew(N, O, lines, found.pos, found.tier, isCtx, oIndex);
      lines = [...lines.slice(0, found.pos), ...N2, ...lines.slice(found.pos + O.length)];
      cursor = found.pos + N2.length;
    }
    const out = joinLines(lines, br, final);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: V4aSection = { kind, path, moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    i++;
    // collect the section's raw lines until the next section header or *** End Patch
    const raw: Array<{ idx: number; text: string }> = [];
    while (i < last) {
      const t = lines[i]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      raw.push({ idx: i, text: t });
      i++;
    }
    // Blank lines at the end of a section (before the next section or `*** End Patch`) are not
    // part of it; blank means empty or only whitespace (SPEC.md section 4's sense).
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text === '') sec.lines.push('');
        else if (r.text.startsWith('+')) sec.lines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (r.text !== '') throw new Exit2(`error: parse ${r.idx + 1}`);
      }
    } else {
      // update: optional `*** Move to:` as the first line, then chunks
      let j = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.text.slice(13).trim();
        j = 1;
      }
      let chunk: V4aChunk | null = null;
      const startChunk = (anchor: string | null): void => {
        chunk = { anchor, eof: false, body: [] };
        sec.chunks.push(chunk);
      };
      let afterEof = false;
      for (; j < raw.length; j++) {
        const r = raw[j]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          startChunk(t.slice(2).trim());
          afterEof = false;
          continue;
        }
        if (t === '*** End of File') {
          if (chunk === null) startChunk(null);
          chunk!.eof = true;
          afterEof = true;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            startChunk(null);
          } else if (afterEof) {
            throw new Exit2(`error: parse ${r.idx + 1}`);
          }
          chunk!.body.push({ kind: t === '' ? ' ' : t[0]!, text: t === '' ? '' : t.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
    }
    sections.push(sec);
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
      : kind === 'search-replace' ? parseSearchReplace(lines, strict)
      : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, in byte order of the paths; a successful move prints `R <old> -> <new>` (sorted
  // by <new>) instead of its `D` and `A` lines (SPEC.md section 2).
  const rowItems: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.now.get(oldP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rowItems.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowItems.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowItems.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowItems.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
