export type ContextType =
  | 'experiment'
  | 'decision'
  | 'assumption'
  | 'data-context'
  | 'result'
  | 'note';

export interface TemplateField {
  /** Bold label rendered as `**Label:**` */
  label: string;
  /** Italic placeholder shown until the user replaces it; also the input-box prompt in guided mode */
  hint: string;
  /** Pre-filled value instead of a hint (e.g. "Unvalidated") */
  default?: string;
}

export interface ContextTemplate {
  type: ContextType;
  emoji: string;
  title: string;
  /** One line shown in the type picker: when to reach for this type */
  description: string;
  /** Codicon name used in the timeline view */
  icon: string;
  fields: TemplateField[];
}

/** Metadata block stored as an HTML comment at the top of every context cell. */
export interface ContextHeader {
  id: string;
  type: ContextType;
  /** "YYYY-MM-DD HH:mm:ss ±HH:MM" */
  created: string;
  updated: string;
  notebookPath: string;
  /** nbformat cell id of the linked cell, when the notebook has one */
  cellId?: string;
  /** Index of the linked cell at capture / last re-link time */
  cellIndex: number;
  /** Content hash of the linked cell at capture / last re-link time */
  cellHash: string;
}

export interface ParsedField {
  label: string;
  /** Empty string when the field is untouched, "—", or blank */
  value: string;
}

export interface ParsedContext {
  header: ContextHeader;
  fields: ParsedField[];
  /** One-line summary derived from the first filled field */
  title: string;
  /** Hash of everything after the header; used to detect edits at save time */
  bodyHash: string;
}

/** Structured copy of the header (plus snapshot) stored in ipynb cell metadata under `notebook_context`. */
export interface CtxMeta {
  id: string;
  type: ContextType;
  created: string;
  updated: string;
  cell_id?: string;
  cell_index: number;
  cell_hash: string;
  /** Source of the linked cell at capture time, for diffing later */
  snapshot?: string;
  /** Hash of the context cell body at last save, for auto-updating the timestamp */
  self_hash?: string;
}
