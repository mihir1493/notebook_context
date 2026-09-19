import { createHash, randomInt } from 'crypto';
import { getTemplate, isContextType } from './templates';
import { ContextHeader, ContextTemplate, ParsedContext, ParsedField } from './types';

export const HEADER_OPEN = '<!-- notebook-context';
export const HEADER_CLOSE = '-->';
export const EMPTY_VALUE = '—';

// ---------------------------------------------------------------------------
// Hashing, timestamps, ids
// ---------------------------------------------------------------------------

/** Short, whitespace-insensitive content hash: `sha256:` + 12 hex chars. */
export function hashSource(text: string): string {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
  return 'sha256:' + createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/** Local time with offset, e.g. `2026-09-19 14:03:22 +05:30`. */
export function formatTimestamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function parseTimestamp(s: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*([+-]\d{2}:\d{2}|Z))?/.exec(s.trim());
  if (!m) {
    return undefined;
  }
  if (m[7]) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}`);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I

export function generateId(existing: Iterable<string>, style: 'sequential' | 'random'): string {
  const taken = new Set(existing);
  if (style === 'sequential') {
    let max = 0;
    for (const id of taken) {
      const m = /^CTX-(\d+)$/.exec(id);
      if (m) {
        max = Math.max(max, parseInt(m[1], 10));
      }
    }
    const next = `CTX-${String(max + 1).padStart(3, '0')}`;
    if (!taken.has(next)) {
      return next;
    }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    let s = 'CTX-';
    for (let i = 0; i < 6; i++) {
      s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    }
    if (!taken.has(s)) {
      return s;
    }
  }
  return `CTX-${Date.now().toString(36).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Header block  <!-- notebook-context ... -->
// ---------------------------------------------------------------------------

export function serializeHeader(h: ContextHeader): string {
  const lines = [
    HEADER_OPEN,
    `@context_id: ${h.id}`,
    `@type: ${h.type}`,
    `@created_timestamp: ${h.created}`,
    `@updated_timestamp: ${h.updated}`,
    `@notebook_path: ${h.notebookPath}`,
  ];
  if (h.cellId) {
    lines.push(`@cell_id: ${h.cellId}`);
  }
  lines.push(`@cell_index: ${h.cellIndex}`, `@cell_hash: ${h.cellHash}`, HEADER_CLOSE);
  return lines.join('\n');
}

export function isContextSource(text: string): boolean {
  return text.trimStart().startsWith(HEADER_OPEN);
}

/** Splits a cell's source into the header comment and the markdown body. */
export function splitContextCell(text: string): { headerText: string; body: string } | undefined {
  const start = text.indexOf(HEADER_OPEN);
  if (start < 0 || text.slice(0, start).trim() !== '') {
    return undefined;
  }
  const end = text.indexOf(HEADER_CLOSE, start);
  if (end < 0) {
    return undefined;
  }
  const closeEnd = end + HEADER_CLOSE.length;
  return { headerText: text.slice(start, closeEnd), body: text.slice(closeEnd).replace(/^\r?\n/, '') };
}

export function parseHeader(headerText: string): ContextHeader | undefined {
  const map = new Map<string, string>();
  for (const line of headerText.split('\n')) {
    const m = /^\s*#?\s*@([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (m) {
      map.set(m[1], m[2]);
    }
  }
  const id = map.get('context_id');
  const type = map.get('type') ?? '';
  if (!id || !isContextType(type)) {
    return undefined;
  }
  const created = map.get('created_timestamp') ?? '';
  const idx = parseInt(map.get('cell_index') ?? '', 10);
  return {
    id,
    type,
    created,
    updated: map.get('updated_timestamp') ?? created,
    notebookPath: map.get('notebook_path') ?? '',
    cellId: map.get('cell_id') || undefined,
    cellIndex: isNaN(idx) ? -1 : idx,
    cellHash: map.get('cell_hash') ?? '',
  };
}

/** Sets (or appends) one `@key: value` line inside the header block. */
export function setHeaderField(text: string, key: string, value: string): string {
  const split = splitContextCell(text);
  if (!split) {
    return text;
  }
  const re = new RegExp(`^(\\s*#?\\s*@${key}:).*$`, 'm');
  let header = split.headerText;
  if (re.test(header)) {
    header = header.replace(re, `$1 ${value}`);
  } else {
    header = header.replace(/\n-->$/, `\n@${key}: ${value}\n-->`);
  }
  return text.replace(split.headerText, header);
}

// ---------------------------------------------------------------------------
// Rendering & parsing the markdown body
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Field values by label; missing → hint placeholder, empty string → "—" */
  values?: Record<string, string>;
  footer?: boolean;
}

export function renderContextCell(tpl: ContextTemplate, header: ContextHeader, opts: RenderOptions = {}): string {
  const lines: string[] = [serializeHeader(header), '', `### ${tpl.emoji} ${tpl.title} · ${header.id}`, ''];
  for (const f of tpl.fields) {
    const provided = opts.values?.[f.label];
    let value: string;
    if (provided !== undefined) {
      value = provided.trim() === '' ? EMPTY_VALUE : provided.trim();
    } else if (f.default !== undefined) {
      value = f.default;
    } else {
      value = `_${f.hint}_`;
    }
    lines.push(`**${f.label}:** ${value}`, '');
  }
  if (opts.footer !== false) {
    lines.push(`<sub>🧠 ${header.id} · created ${header.created} · linked to cell ${header.cellIndex}</sub>`);
  }
  return lines.join('\n');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces any hint the user never touched with "—". */
export function stripUntouchedHints(text: string, tpl: ContextTemplate): string {
  let out = text;
  for (const f of tpl.fields) {
    if (f.default !== undefined) {
      continue;
    }
    const re = new RegExp(`^(\\*\\*${escapeRe(f.label)}:\\*\\*)\\s*_${escapeRe(f.hint)}_\\s*$`, 'm');
    out = out.replace(re, `$1 ${EMPTY_VALUE}`);
  }
  return out;
}

export function parseFields(body: string, tpl: ContextTemplate | undefined): ParsedField[] {
  const fields: ParsedField[] = [];
  let current: { label: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) {
      return;
    }
    let value = current.lines.join('\n').trim();
    const hint = tpl?.fields.find((f) => f.label === current!.label)?.hint;
    if (value === EMPTY_VALUE || (hint !== undefined && value === `_${hint}_`)) {
      value = '';
    }
    fields.push({ label: current.label, value });
    current = undefined;
  };
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^<sub>/.test(line)) {
      flush();
      break;
    }
    const m = /^\*\*([^*]+?):\*\*\s?(.*)$/.exec(line);
    if (m) {
      flush();
      current = { label: m[1], lines: [m[2]] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return fields;
}

export function deriveTitle(fields: ParsedField[], tpl: ContextTemplate | undefined): string {
  const first = fields.find((f) => f.value !== '' && f.value !== tpl?.fields.find((t) => t.label === f.label)?.default);
  if (!first) {
    return `${tpl?.title ?? 'Context'} (not filled in yet)`;
  }
  const line = first.value.split('\n')[0].replace(/[*_`]/g, '').trim();
  return line.length > 80 ? line.slice(0, 77).trimEnd() + '…' : line;
}

export function parseContextCell(text: string): ParsedContext | undefined {
  const split = splitContextCell(text);
  if (!split) {
    return undefined;
  }
  const header = parseHeader(split.headerText);
  if (!header) {
    return undefined;
  }
  const tpl = getTemplate(header.type);
  const fields = parseFields(split.body, tpl);
  return { header, fields, title: deriveTitle(fields, tpl), bodyHash: hashSource(split.body) };
}

export function countFilled(fields: ParsedField[], tpl: ContextTemplate | undefined): number {
  return fields.filter((f) => f.value !== '' && f.value !== tpl?.fields.find((t) => t.label === f.label)?.default).length;
}
