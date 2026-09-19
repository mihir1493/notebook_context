import * as vscode from 'vscode';
import { ContextRecord, findNotebook, getCtxMeta } from './notebookUtils';

export const SNAPSHOT_SCHEME = 'notebook-context';

/** Serves the code snapshot stored in a context cell's metadata as a read-only document. */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const notebook = findNotebook(params.get('nb') ?? '');
    const idx = Number(params.get('cell'));
    const cell = notebook && Number.isInteger(idx) && idx < notebook.cellCount ? notebook.cellAt(idx) : undefined;
    const snapshot = cell ? getCtxMeta(cell)?.snapshot : undefined;
    if (snapshot === undefined) {
      return [
        '# No code snapshot is stored for this context.',
        '# Snapshots are kept in the context cell metadata when',
        '# "notebookContext.storeCodeSnapshot" is enabled at capture time.',
      ].join('\n');
    }
    return snapshot;
  }
}

function extensionFor(languageId: string | undefined): string {
  switch (languageId) {
    case 'python':
      return 'py';
    case 'r':
      return 'r';
    case 'julia':
      return 'jl';
    case 'markdown':
      return 'md';
    default:
      return languageId ?? 'txt';
  }
}

/** Opens "code at capture" ↔ "current code" in a diff editor. */
export async function showDiff(record: ContextRecord): Promise<void> {
  const h = record.parsed.header;
  if (!record.target) {
    void vscode.window.showWarningMessage(`${h.id}: the linked cell could not be found in this notebook.`);
    return;
  }
  const ext = extensionFor(record.target.document.languageId);
  const left = vscode.Uri.from({
    scheme: SNAPSHOT_SCHEME,
    path: `/${h.id}/at-capture.${ext}`,
    query: `nb=${encodeURIComponent(record.notebook.uri.toString())}&cell=${record.cell.index}&v=${record.notebook.version}`,
  });
  const label = record.drifted ? 'changed' : 'unchanged';
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    record.target.document.uri,
    `${h.id}: code at capture (${h.created.slice(0, 16)}) ↔ current — ${label}`
  );
}
