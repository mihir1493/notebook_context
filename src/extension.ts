import * as vscode from 'vscode';
import { captureOrSave, markCurrent, registerAutoTimestamp } from './capture';
import { ContextCellStatusBarProvider } from './cellStatusBar';
import { exportContextLog } from './export';
import {
  activeCell,
  ContextRecord,
  editorFor,
  findNotebook,
  focusCell,
  forgetNotebook,
  indexNotebook,
  isContextCell,
  isJupyter,
  isNotebookCell,
  JUPYTER_NOTEBOOK_TYPE,
} from './notebookUtils';
import { showDiff, SnapshotContentProvider, SNAPSHOT_SCHEME } from './snapshot';
import { RecordNode, TimelineProvider } from './timeline';

export function activate(context: vscode.ExtensionContext): void {
  const timeline = new TimelineProvider();
  const treeView = vscode.window.createTreeView('notebookContext.timeline', {
    treeDataProvider: timeline,
    showCollapseAll: true,
  });
  timeline.attach(treeView);
  const statusBar = new ContextCellStatusBarProvider();

  // Re-index lazily; just poke the views when a notebook changes (debounced per burst of edits).
  let pending: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (pending) {
      clearTimeout(pending);
    }
    pending = setTimeout(() => {
      pending = undefined;
      timeline.refresh();
      statusBar.refresh();
    }, 250);
  };

  context.subscriptions.push(
    timeline,
    treeView,
    statusBar,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(JUPYTER_NOTEBOOK_TYPE, statusBar),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, new SnapshotContentProvider()),
    registerAutoTimestamp(),
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (isJupyter(e.notebook)) {
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidOpenNotebookDocument(scheduleRefresh),
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      forgetNotebook(nb);
      scheduleRefresh();
    }),

    vscode.commands.registerCommand('notebookContext.capture', (arg?: unknown) => captureOrSave(arg)),
    vscode.commands.registerCommand('notebookContext.refreshTimeline', () => {
      const nb = timeline.currentNotebook;
      if (nb) {
        forgetNotebook(nb);
      }
      timeline.refresh();
      statusBar.refresh();
    }),
    vscode.commands.registerCommand('notebookContext.groupBy', () => timeline.pickGroupBy()),
    vscode.commands.registerCommand('notebookContext.export', async () => {
      const nb = timeline.currentNotebook ?? vscode.window.activeNotebookEditor?.notebook;
      if (!isJupyter(nb)) {
        void vscode.window.showInformationMessage('Notebook Context: open a Jupyter notebook to export its context log.');
        return;
      }
      await exportContextLog(nb);
    }),
    vscode.commands.registerCommand('notebookContext.reveal', async (arg?: unknown) => {
      const r = await resolveRecord(arg);
      if (r) {
        await focusCell(await editorFor(r.notebook), r.cell.index, false);
      }
    }),
    vscode.commands.registerCommand('notebookContext.revealTarget', async (arg?: unknown) => {
      const r = await resolveRecord(arg);
      if (!r) {
        return;
      }
      if (!r.target) {
        void vscode.window.showWarningMessage(`${r.parsed.header.id}: linked cell not found.`);
        return;
      }
      await focusCell(await editorFor(r.notebook), r.target.index, false);
    }),
    vscode.commands.registerCommand('notebookContext.showDiff', async (arg?: unknown) => {
      const r = await resolveRecord(arg);
      if (r) {
        await showDiff(r);
      }
    }),
    vscode.commands.registerCommand('notebookContext.markCurrent', async (arg?: unknown) => {
      const r = await resolveRecord(arg);
      if (r) {
        await markCurrent(r);
      }
    }),
    vscode.commands.registerCommand('notebookContext.cellMenu', (nbUri: string, cellIndex: number) => cellMenu(nbUri, cellIndex))
  );
}

export function deactivate(): void {
  // nothing to clean up beyond context.subscriptions
}

/**
 * Commands can be invoked from the tree (RecordNode), the status bar
 * (record), a cell toolbar (NotebookCell) or the palette (nothing). Normalise
 * all of those to a ContextRecord, asking the user to pick when ambiguous.
 */
async function resolveRecord(arg: unknown): Promise<ContextRecord | undefined> {
  if (arg instanceof RecordNode) {
    return arg.record;
  }
  if (arg && typeof arg === 'object' && 'parsed' in arg && 'cell' in arg) {
    return arg as ContextRecord;
  }
  let cell: vscode.NotebookCell | undefined;
  if (isNotebookCell(arg)) {
    cell = arg;
  } else {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor || !isJupyter(editor.notebook)) {
      void vscode.window.showInformationMessage('Notebook Context: focus a cell in a Jupyter notebook first.');
      return undefined;
    }
    cell = activeCell(editor);
  }
  if (!cell) {
    return undefined;
  }
  return recordForCell(cell);
}

async function recordForCell(cell: vscode.NotebookCell): Promise<ContextRecord | undefined> {
  const records = indexNotebook(cell.notebook);
  if (isContextCell(cell)) {
    return records.find((r) => r.cell.index === cell.index);
  }
  const linked = records.filter((r) => r.target?.index === cell.index);
  if (linked.length === 0) {
    void vscode.window.showInformationMessage('No context is linked to this cell yet. Press Ctrl+Alt+C to capture some.');
    return undefined;
  }
  if (linked.length === 1) {
    return linked[0];
  }
  const picked = await vscode.window.showQuickPick(
    linked.map((r) => ({
      label: `${r.template.emoji} ${r.parsed.title}`,
      description: `${r.parsed.header.id} · ${r.parsed.header.created}` + (r.drifted ? ' · ⚠ code changed' : ''),
      record: r,
    })),
    { title: `Context linked to cell ${cell.index}`, placeHolder: 'Pick a context' }
  );
  return picked?.record;
}

/** Click target for the per-cell status bar item. */
async function cellMenu(nbUri: string, cellIndex: number): Promise<void> {
  const notebook = findNotebook(nbUri);
  if (!notebook || cellIndex >= notebook.cellCount) {
    return;
  }
  const record = await recordForCell(notebook.cellAt(cellIndex));
  if (!record) {
    return;
  }
  const h = record.parsed.header;
  type Action = vscode.QuickPickItem & { run: () => Promise<void> };
  const actions: Action[] = [];
  if (record.target) {
    actions.push({
      label: '$(diff) Show code diff since capture',
      description: record.drifted ? '⚠ the linked code changed' : 'no changes',
      run: () => showDiff(record),
    });
    if (record.drifted) {
      actions.push({
        label: '$(check) Mark linked code as current',
        description: 'accept the new code as this context’s baseline (updates hash + snapshot)',
        run: () => markCurrent(record),
      });
    }
  }
  actions.push(
    {
      label: '$(note) Reveal context cell',
      description: `${h.id} · ${record.template.title}`,
      run: async () => focusCell(await editorFor(notebook), record.cell.index, false),
    },
    {
      label: '$(edit) Edit context cell',
      run: async () => focusCell(await editorFor(notebook), record.cell.index, true),
    }
  );
  if (record.target) {
    actions.push({
      label: '$(go-to-file) Reveal linked code cell',
      description: `cell ${record.target.index}`,
      run: async () => focusCell(await editorFor(notebook), record.target!.index, false),
    });
  }
  const picked = await vscode.window.showQuickPick(actions, {
    title: `🧠 ${h.id} · ${record.template.title}`,
    placeHolder: record.parsed.title,
  });
  await picked?.run();
}
