import * as vscode from 'vscode';
import {
  countFilled,
  formatTimestamp,
  generateId,
  hashSource,
  parseContextCell,
  renderContextCell,
  setHeaderField,
  splitContextCell,
  stripUntouchedHints,
} from './metadata';
import {
  activeCell,
  config,
  ContextRecord,
  focusCell,
  fullRange,
  getCellId,
  getCtxMeta,
  indexNotebook,
  isContextCell,
  isJupyter,
  isNotebookCell,
  notebookDisplayPath,
  withCtxMeta,
} from './notebookUtils';
import { TEMPLATES } from './templates';
import { ContextHeader, ContextTemplate, CtxMeta } from './types';

/**
 * Entry point for the 🧠 button and Ctrl+Alt+C. Context-aware: on a context
 * cell it saves; on any other cell it starts a capture for that cell.
 */
export async function captureOrSave(arg?: unknown): Promise<void> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || !isJupyter(editor.notebook)) {
    void vscode.window.showInformationMessage('Notebook Context: open a Jupyter notebook and focus a cell first.');
    return;
  }
  const cell = isNotebookCell(arg) && arg.notebook === editor.notebook ? arg : activeCell(editor);
  if (!cell) {
    void vscode.window.showInformationMessage('Notebook Context: focus a cell first.');
    return;
  }
  if (isContextCell(cell)) {
    await saveContext(editor, cell);
  } else {
    await startCapture(editor, cell);
  }
}

interface TypePick extends vscode.QuickPickItem {
  template: ContextTemplate;
}

async function pickType(): Promise<ContextTemplate | undefined> {
  const items: TypePick[] = TEMPLATES.map((t, i) => ({
    label: `${i + 1}  ${t.emoji} ${t.title}`,
    description: t.description,
    detail: t.fields.map((f) => f.label).join(' · '),
    template: t,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: '🧠 Capture Context',
    placeHolder: 'What are you capturing? (type a number or a name)',
    matchOnDescription: true,
  });
  return picked?.template;
}

async function startCapture(editor: vscode.NotebookEditor, target: vscode.NotebookCell): Promise<void> {
  const tpl = await pickType();
  if (!tpl) {
    return;
  }
  const notebook = editor.notebook;
  const now = formatTimestamp();
  const existingIds = indexNotebook(notebook).map((r) => r.parsed.header.id);
  const insertAt = target.index;
  const source = target.document.getText();

  const header: ContextHeader = {
    id: generateId(existingIds, config('idStyle', 'sequential')),
    type: tpl.type,
    created: now,
    updated: now,
    notebookPath: notebookDisplayPath(notebook.uri),
    cellId: getCellId(target),
    cellIndex: insertAt + 1, // the target shifts down by one once we insert above it
    cellHash: hashSource(source),
  };

  const mode = config<'template' | 'guided'>('captureMode', 'template');
  let values: Record<string, string> | undefined;
  if (mode === 'guided') {
    values = await collectGuided(tpl, header.id);
    if (!values) {
      return;
    }
  }

  const text = renderContextCell(tpl, header, { values, footer: config('showFooter', true) });
  const meta: CtxMeta = {
    id: header.id,
    type: header.type,
    created: header.created,
    updated: header.updated,
    cell_id: header.cellId,
    cell_index: header.cellIndex,
    cell_hash: header.cellHash,
    snapshot: config('storeCodeSnapshot', true) ? source : undefined,
    self_hash: hashSource(splitContextCell(text)?.body ?? ''),
  };

  const data = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, text, 'markdown');
  data.metadata = { notebook_context: meta };
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertAt, [data])]);
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage('Notebook Context: could not insert the context cell.');
    return;
  }

  await focusCell(editor, insertAt, mode === 'template');
  if (mode === 'template') {
    vscode.window.setStatusBarMessage(
      `🧠 ${header.id} added above cell ${header.cellIndex} — fill it in, then press Ctrl+Alt+C (or click 🧠) to save`,
      10000
    );
  } else {
    vscode.window.setStatusBarMessage(`🧠 ${header.id} saved (${countFilled(
      Object.entries(values!).map(([label, value]) => ({ label, value })),
      tpl
    )}/${tpl.fields.length} fields)`, 6000);
  }
}

/** Guided mode: one input box per field. Returns undefined if the user escapes. */
async function collectGuided(tpl: ContextTemplate, id: string): Promise<Record<string, string> | undefined> {
  const values: Record<string, string> = {};
  for (let i = 0; i < tpl.fields.length; i++) {
    const f = tpl.fields[i];
    const answer = await vscode.window.showInputBox({
      title: `${tpl.emoji} ${tpl.title} · ${id}  (${i + 1}/${tpl.fields.length})`,
      prompt: `${f.label} — ${f.hint}`,
      placeHolder: f.default ?? 'Leave empty to skip',
      value: f.default,
      ignoreFocusOut: true,
    });
    if (answer === undefined) {
      return undefined;
    }
    values[f.label] = answer;
  }
  return values;
}

/**
 * Save: strip untouched hints, bump @updated_timestamp, refresh the link
 * (index/id may have shifted), record the body hash, then render the cell.
 */
export async function saveContext(editor: vscode.NotebookEditor, cell: vscode.NotebookCell): Promise<void> {
  const notebook = editor.notebook;
  const record = indexNotebook(notebook).find((r) => r.cell.index === cell.index);
  if (!record) {
    void vscode.window.showErrorMessage('Notebook Context: this cell has a context header I could not parse.');
    return;
  }
  let text = stripUntouchedHints(cell.document.getText(), record.template);
  const now = formatTimestamp();
  const parsedBefore = parseContextCell(text);
  const changed = parsedBefore && parsedBefore.bodyHash !== record.meta?.self_hash;
  if (changed) {
    text = setHeaderField(text, 'updated_timestamp', now);
  }
  if (record.target) {
    text = setHeaderField(text, 'cell_index', String(record.target.index));
    const id = getCellId(record.target);
    if (id) {
      text = setHeaderField(text, 'cell_id', id);
    }
  }
  const parsed = parseContextCell(text)!;
  const meta: CtxMeta = {
    ...(record.meta ?? {}),
    id: parsed.header.id,
    type: parsed.header.type,
    created: parsed.header.created,
    updated: parsed.header.updated,
    cell_id: parsed.header.cellId,
    cell_index: parsed.header.cellIndex,
    cell_hash: parsed.header.cellHash,
    self_hash: parsed.bodyHash,
  };

  const edit = new vscode.WorkspaceEdit();
  if (text !== cell.document.getText()) {
    edit.replace(cell.document.uri, fullRange(cell.document), text);
  }
  edit.set(notebook.uri, [vscode.NotebookEdit.updateCellMetadata(cell.index, withCtxMeta(cell.metadata, meta))]);
  await vscode.workspace.applyEdit(edit);
  await focusCell(editor, cell.index, false);

  const filled = countFilled(parsed.fields, record.template);
  const msg = `🧠 ${parsed.header.id} saved — ${filled}/${record.template.fields.length} fields filled`;
  if (filled === 0) {
    void vscode.window.showWarningMessage(`${msg}. Click 🧠 on the cell to keep editing.`);
  } else {
    vscode.window.setStatusBarMessage(msg, 6000);
  }
}

/**
 * "Mark as current": accept the linked cell's present code as the new
 * baseline — refresh hash, snapshot and index, bump the updated timestamp.
 */
export async function markCurrent(record: ContextRecord): Promise<void> {
  if (!record.target) {
    void vscode.window.showWarningMessage(`${record.parsed.header.id}: linked cell not found, nothing to re-link.`);
    return;
  }
  const now = formatTimestamp();
  const source = record.target.document.getText();
  let text = record.cell.document.getText();
  text = setHeaderField(text, 'cell_hash', hashSource(source));
  text = setHeaderField(text, 'cell_index', String(record.target.index));
  text = setHeaderField(text, 'updated_timestamp', now);
  const id = getCellId(record.target);
  if (id) {
    text = setHeaderField(text, 'cell_id', id);
  }
  const parsed = parseContextCell(text)!;
  const meta: CtxMeta = {
    ...(getCtxMeta(record.cell) ?? {}),
    id: parsed.header.id,
    type: parsed.header.type,
    created: parsed.header.created,
    updated: now,
    cell_id: parsed.header.cellId,
    cell_index: parsed.header.cellIndex,
    cell_hash: parsed.header.cellHash,
    snapshot: config('storeCodeSnapshot', true) ? source : undefined,
    self_hash: parsed.bodyHash,
  };
  const edit = new vscode.WorkspaceEdit();
  edit.replace(record.cell.document.uri, fullRange(record.cell.document), text);
  edit.set(record.notebook.uri, [
    vscode.NotebookEdit.updateCellMetadata(record.cell.index, withCtxMeta(record.cell.metadata, meta)),
  ]);
  await vscode.workspace.applyEdit(edit);
  vscode.window.setStatusBarMessage(`🧠 ${parsed.header.id} now tracks the current code of cell ${record.target.index}`, 5000);
}

/**
 * On notebook save: if a context cell's body changed since its last recorded
 * hash, refresh @updated_timestamp so the file carries an honest timestamp
 * even when the user saved with Cmd+S instead of the 🧠 button.
 */
export function registerAutoTimestamp(): vscode.Disposable {
  return vscode.workspace.onWillSaveNotebookDocument((e) => {
    if (!isJupyter(e.notebook) || !config('autoUpdateTimestamp', true)) {
      return;
    }
    e.waitUntil(
      (async () => {
        const edits: vscode.WorkspaceEdit[] = [];
        const now = formatTimestamp();
        for (const cell of e.notebook.getCells()) {
          if (!isContextCell(cell)) {
            continue;
          }
          const text = cell.document.getText();
          const parsed = parseContextCell(text);
          if (!parsed) {
            continue;
          }
          const meta = getCtxMeta(cell);
          if (meta?.self_hash === parsed.bodyHash) {
            continue;
          }
          const edit = new vscode.WorkspaceEdit();
          let newText = text;
          // Only bump the timestamp when we know a previous body hash and it differs.
          if (meta?.self_hash && meta.self_hash !== parsed.bodyHash) {
            newText = setHeaderField(text, 'updated_timestamp', now);
            edit.replace(cell.document.uri, fullRange(cell.document), newText);
          }
          const header = parseContextCell(newText)?.header ?? parsed.header;
          const nextMeta: CtxMeta = {
            ...(meta ?? {}),
            id: header.id,
            type: header.type,
            created: header.created,
            updated: header.updated,
            cell_id: header.cellId,
            cell_index: header.cellIndex,
            cell_hash: header.cellHash,
            self_hash: parsed.bodyHash,
          };
          edit.set(e.notebook.uri, [
            vscode.NotebookEdit.updateCellMetadata(cell.index, withCtxMeta(cell.metadata, nextMeta)),
          ]);
          edits.push(edit);
        }
        return edits;
      })()
    );
  });
}
