import * as vscode from 'vscode';
import { hashSource, isContextSource, parseContextCell } from './metadata';
import { getTemplate, TEMPLATES } from './templates';
import { ContextHeader, ContextTemplate, CtxMeta, ParsedContext } from './types';

export const JUPYTER_NOTEBOOK_TYPE = 'jupyter-notebook';

/** A parsed context cell plus its resolved link into the live notebook. */
export interface ContextRecord {
  notebook: vscode.NotebookDocument;
  /** The markdown cell holding the context */
  cell: vscode.NotebookCell;
  parsed: ParsedContext;
  template: ContextTemplate;
  /** The cell this context describes, if it could be resolved */
  target?: vscode.NotebookCell;
  currentHash?: string;
  /** True when the linked cell's code no longer matches the hash taken at capture */
  drifted: boolean;
  meta?: CtxMeta;
}

export function isJupyter(notebook: vscode.NotebookDocument | undefined): notebook is vscode.NotebookDocument {
  return !!notebook && notebook.notebookType === JUPYTER_NOTEBOOK_TYPE;
}

export function isContextCell(cell: vscode.NotebookCell): boolean {
  return cell.kind === vscode.NotebookCellKind.Markup && isContextSource(cell.document.getText());
}

// VS Code ≥1.85 stores ipynb cell metadata flat; older versions nested it under `custom.metadata`.
// Read both, write flat.
type AnyMeta = { [key: string]: unknown } | undefined;

export function getCellId(cell: vscode.NotebookCell): string | undefined {
  const m = cell.metadata as AnyMeta;
  const nested = (m?.custom as AnyMeta)?.metadata as AnyMeta;
  const id = m?.id ?? nested?.id;
  return typeof id === 'string' ? id : undefined;
}

export function getCtxMeta(cell: vscode.NotebookCell): CtxMeta | undefined {
  const m = cell.metadata as AnyMeta;
  const nested = (m?.custom as AnyMeta)?.metadata as AnyMeta;
  const ctx = m?.notebook_context ?? nested?.notebook_context;
  return ctx && typeof ctx === 'object' ? (ctx as CtxMeta) : undefined;
}

export function withCtxMeta(existing: AnyMeta, ctx: CtxMeta): { [key: string]: unknown } {
  return { ...(existing ?? {}), notebook_context: ctx };
}

export function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), doc.positionAt(doc.getText().length));
}

export function notebookDisplayPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

export function firstCodeLine(cell: vscode.NotebookCell): string {
  const line = cell.document
    .getText()
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  return line ? (line.length > 60 ? line.slice(0, 57) + '…' : line) : '(empty cell)';
}

/**
 * Finds the cell a context describes. Order: nbformat cell id → the first
 * non-context cell directly below → the index recorded at capture.
 */
export function resolveTarget(
  notebook: vscode.NotebookDocument,
  ctxIndex: number,
  header: ContextHeader
): vscode.NotebookCell | undefined {
  if (header.cellId) {
    for (const cell of notebook.getCells()) {
      if (cell.index !== ctxIndex && getCellId(cell) === header.cellId) {
        return cell;
      }
    }
  }
  for (let i = ctxIndex + 1; i < notebook.cellCount; i++) {
    const cell = notebook.cellAt(i);
    if (!isContextCell(cell)) {
      return cell;
    }
  }
  if (header.cellIndex >= 0 && header.cellIndex < notebook.cellCount && header.cellIndex !== ctxIndex) {
    return notebook.cellAt(header.cellIndex);
  }
  return undefined;
}

const indexCache = new Map<string, { version: number; records: ContextRecord[] }>();

/** Parses every context cell in the notebook. Cached per notebook version. */
export function indexNotebook(notebook: vscode.NotebookDocument): ContextRecord[] {
  const key = notebook.uri.toString();
  const cached = indexCache.get(key);
  if (cached && cached.version === notebook.version) {
    return cached.records;
  }
  const records: ContextRecord[] = [];
  for (const cell of notebook.getCells()) {
    if (!isContextCell(cell)) {
      continue;
    }
    const parsed = parseContextCell(cell.document.getText());
    if (!parsed) {
      continue;
    }
    const template = getTemplate(parsed.header.type) ?? TEMPLATES[TEMPLATES.length - 1];
    const target = resolveTarget(notebook, cell.index, parsed.header);
    const currentHash = target ? hashSource(target.document.getText()) : undefined;
    records.push({
      notebook,
      cell,
      parsed,
      template,
      target,
      currentHash,
      drifted: !!target && !!parsed.header.cellHash && currentHash !== parsed.header.cellHash,
      meta: getCtxMeta(cell),
    });
  }
  indexCache.set(key, { version: notebook.version, records });
  return records;
}

export function forgetNotebook(notebook: vscode.NotebookDocument): void {
  indexCache.delete(notebook.uri.toString());
}

export function findNotebook(uriString: string): vscode.NotebookDocument | undefined {
  return vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === uriString);
}

export async function editorFor(notebook: vscode.NotebookDocument): Promise<vscode.NotebookEditor> {
  const visible = vscode.window.visibleNotebookEditors.find((e) => e.notebook === notebook);
  return visible ?? vscode.window.showNotebookDocument(notebook, { preserveFocus: false });
}

/** Selects a cell, scrolls it into view and optionally opens it for editing. */
export async function focusCell(editor: vscode.NotebookEditor, index: number, edit: boolean): Promise<void> {
  const range = new vscode.NotebookRange(index, index + 1);
  editor.selections = [range];
  editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
  await vscode.commands.executeCommand(edit ? 'notebook.cell.edit' : 'notebook.cell.quitEdit');
}

export function activeCell(editor: vscode.NotebookEditor): vscode.NotebookCell | undefined {
  const sel = editor.selections[0];
  if (!sel || sel.isEmpty || sel.start >= editor.notebook.cellCount) {
    return undefined;
  }
  return editor.notebook.cellAt(sel.start);
}

export function isNotebookCell(arg: unknown): arg is vscode.NotebookCell {
  const c = arg as vscode.NotebookCell | undefined;
  return !!c && typeof c === 'object' && 'document' in c && 'notebook' in c && typeof c.index === 'number';
}

export function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('notebookContext').get<T>(key, fallback);
}
