import * as vscode from 'vscode';
import { indexNotebook, isContextCell, isJupyter } from './notebookUtils';

/**
 * Small text at the bottom of each cell:
 *   context cell → "🧠 CTX-003 · Experiment · ⚠ code changed"
 *   code cell    → "🧠 2 contexts · ⚠ 1 stale"
 * Clicking opens the per-cell action menu.
 */
export class ContextCellStatusBarProvider implements vscode.NotebookCellStatusBarItemProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    if (!isJupyter(cell.notebook)) {
      return [];
    }
    const records = indexNotebook(cell.notebook);
    const menu = (tooltip: string, text: string): vscode.NotebookCellStatusBarItem => {
      const item = new vscode.NotebookCellStatusBarItem(text, vscode.NotebookCellStatusBarAlignment.Right);
      item.tooltip = tooltip;
      item.command = {
        title: 'Context actions',
        command: 'notebookContext.cellMenu',
        arguments: [cell.notebook.uri.toString(), cell.index],
      };
      return item;
    };

    if (isContextCell(cell)) {
      const r = records.find((rec) => rec.cell.index === cell.index);
      if (!r) {
        return [];
      }
      const h = r.parsed.header;
      let text = `🧠 ${h.id} · ${r.template.title}`;
      let tooltip = `${r.template.title} captured ${h.created}`;
      if (!r.target) {
        text += ' · linked cell not found';
      } else if (r.drifted) {
        text += ' · $(warning) code changed';
        tooltip += `\nCell ${r.target.index} changed since capture — click to diff`;
      } else {
        tooltip += `\nLinked to cell ${r.target.index} (unchanged)`;
      }
      return [menu(tooltip, text)];
    }

    const linked = records.filter((rec) => rec.target?.index === cell.index);
    if (linked.length === 0) {
      return [];
    }
    const stale = linked.filter((rec) => rec.drifted).length;
    const text =
      `🧠 ${linked.length} context${linked.length === 1 ? '' : 's'}` +
      (stale ? ` · $(warning) ${stale} stale` : '');
    const tooltip = linked.map((rec) => `${rec.parsed.header.id} ${rec.template.title}: ${rec.parsed.title}`).join('\n');
    return [menu(tooltip, text)];
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
