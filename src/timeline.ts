import * as vscode from 'vscode';
import { parseTimestamp } from './metadata';
import { config, ContextRecord, firstCodeLine, indexNotebook, isJupyter } from './notebookUtils';
import { TEMPLATES } from './templates';

export type GroupBy = 'time' | 'type' | 'cell';

export class GroupNode {
  constructor(
    public readonly label: string,
    public readonly description: string,
    public readonly icon: vscode.ThemeIcon,
    public readonly records: ContextRecord[]
  ) {}
}
export class RecordNode {
  constructor(public readonly record: ContextRecord) {}
}
export class DetailNode {
  constructor(
    public readonly label: string,
    public readonly description?: string,
    public readonly icon?: vscode.ThemeIcon,
    public readonly command?: vscode.Command,
    public readonly tooltip?: string
  ) {}
}
export type TimelineNode = GroupNode | RecordNode | DetailNode;

export function relativeTime(ts: string): string {
  const d = parseTimestamp(ts);
  if (!d) {
    return ts;
  }
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h ago`;
  }
  if (s < 86400 * 14) {
    return `${Math.floor(s / 86400)}d ago`;
  }
  return ts.slice(0, 10);
}

export class TimelineProvider implements vscode.TreeDataProvider<TimelineNode>, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private notebook: vscode.NotebookDocument | undefined;
  private groupBy: GroupBy = config('timeline.groupBy', 'time');
  private view: vscode.TreeView<TimelineNode> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.setNotebook(vscode.window.activeNotebookEditor?.notebook);
    this.disposables.push(
      vscode.window.onDidChangeActiveNotebookEditor((e) => {
        // Keep showing the last notebook when focus moves to a non-notebook editor.
        if (e) {
          this.setNotebook(e.notebook);
        }
      }),
      vscode.workspace.onDidCloseNotebookDocument((nb) => {
        if (nb === this.notebook) {
          this.setNotebook(vscode.window.activeNotebookEditor?.notebook);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('notebookContext.timeline.groupBy')) {
          this.groupBy = config('timeline.groupBy', 'time');
          this.refresh();
        }
      })
    );
  }

  attach(view: vscode.TreeView<TimelineNode>): void {
    this.view = view;
    this.updateViewChrome();
  }

  get currentNotebook(): vscode.NotebookDocument | undefined {
    return this.notebook;
  }

  setNotebook(nb: vscode.NotebookDocument | undefined): void {
    this.notebook = isJupyter(nb) ? nb : undefined;
    this.refresh();
  }

  async pickGroupBy(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Time', description: 'Newest first', value: 'time' as GroupBy },
        { label: 'Type', description: 'Experiments, decisions, assumptions…', value: 'type' as GroupBy },
        { label: 'Cell', description: 'All context captured for each code cell (its evolution)', value: 'cell' as GroupBy },
      ],
      { title: 'Group timeline by', placeHolder: `Currently: ${this.groupBy}` }
    );
    if (picked) {
      await vscode.workspace
        .getConfiguration('notebookContext')
        .update('timeline.groupBy', picked.value, vscode.ConfigurationTarget.Global);
    }
  }

  refresh(): void {
    this.updateViewChrome();
    this._onDidChange.fire();
  }

  private updateViewChrome(): void {
    if (!this.view) {
      return;
    }
    if (!this.notebook) {
      this.view.description = undefined;
      this.view.message = undefined;
      return;
    }
    const records = indexNotebook(this.notebook);
    const drifted = records.filter((r) => r.drifted).length;
    this.view.description = vscode.workspace.asRelativePath(this.notebook.uri, false).split('/').pop();
    this.view.message =
      records.length === 0
        ? 'No context captured yet. Focus a cell and press Ctrl+Alt+C.'
        : `${records.length} context${records.length === 1 ? '' : 's'}` +
          (drifted ? ` · ⚠ ${drifted} where the code changed since capture` : '') +
          ` · grouped by ${this.groupBy}`;
  }

  getChildren(element?: TimelineNode): TimelineNode[] {
    if (!this.notebook) {
      return [];
    }
    if (!element) {
      return this.rootNodes(indexNotebook(this.notebook));
    }
    if (element instanceof GroupNode) {
      return element.records.map((r) => new RecordNode(r));
    }
    if (element instanceof RecordNode) {
      return this.detailNodes(element.record);
    }
    return [];
  }

  private rootNodes(records: ContextRecord[]): TimelineNode[] {
    const byNewest = [...records].sort(
      (a, b) => (parseTimestamp(b.parsed.header.created)?.getTime() ?? 0) - (parseTimestamp(a.parsed.header.created)?.getTime() ?? 0)
    );
    if (this.groupBy === 'time') {
      return byNewest.map((r) => new RecordNode(r));
    }
    if (this.groupBy === 'type') {
      return TEMPLATES.flatMap((t) => {
        const rs = byNewest.filter((r) => r.template.type === t.type);
        return rs.length ? [new GroupNode(t.title, `${rs.length}`, new vscode.ThemeIcon(t.icon), rs)] : [];
      });
    }
    // group by linked cell, in notebook order; oldest context first so the chain reads top-down
    const groups = new Map<number, ContextRecord[]>();
    for (const r of records) {
      const key = r.target?.index ?? -1;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([idx, rs]) => {
        const target = rs[0].target;
        const label = target ? `Cell ${idx}` : 'Unlinked';
        const desc = target ? `${firstCodeLine(target)} · ${rs.length}` : `${rs.length}`;
        const icon = new vscode.ThemeIcon(target?.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown');
        return new GroupNode(label, desc, icon, rs);
      });
  }

  private detailNodes(r: ContextRecord): DetailNode[] {
    const h = r.parsed.header;
    const nodes: DetailNode[] = [];
    if (r.target) {
      nodes.push(
        new DetailNode(
          `Linked cell ${r.target.index}`,
          firstCodeLine(r.target),
          new vscode.ThemeIcon('link'),
          { title: 'Reveal linked cell', command: 'notebookContext.revealTarget', arguments: [new RecordNode(r)] }
        )
      );
      nodes.push(
        r.drifted
          ? new DetailNode(
              'Code changed since capture',
              'click to diff',
              new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')),
              { title: 'Show diff', command: 'notebookContext.showDiff', arguments: [new RecordNode(r)] },
              `Captured ${h.cellHash}\nNow      ${r.currentHash}`
            )
          : new DetailNode('Code unchanged since capture', h.cellHash, new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')))
      );
    } else {
      nodes.push(new DetailNode('Linked cell not found', `was cell ${h.cellIndex}`, new vscode.ThemeIcon('debug-disconnect')));
    }
    nodes.push(new DetailNode(`Created ${h.created}`, undefined, new vscode.ThemeIcon('calendar')));
    if (h.updated && h.updated !== h.created) {
      nodes.push(new DetailNode(`Updated ${h.updated}`, undefined, new vscode.ThemeIcon('history')));
    }
    for (const f of r.parsed.fields) {
      if (f.value) {
        const first = f.value.split('\n')[0];
        nodes.push(new DetailNode(`${f.label}:`, first, undefined, undefined, f.value));
      }
    }
    return nodes;
  }

  getTreeItem(el: TimelineNode): vscode.TreeItem {
    if (el instanceof GroupNode) {
      const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = el.description;
      item.iconPath = el.icon;
      item.contextValue = 'group';
      return item;
    }
    if (el instanceof RecordNode) {
      const r = el.record;
      const h = r.parsed.header;
      const item = new vscode.TreeItem(r.parsed.title, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${h.id} · ${relativeTime(h.created)}` + (r.drifted ? ' · ⚠ code changed' : '');
      item.iconPath = r.drifted
        ? new vscode.ThemeIcon(r.template.icon, new vscode.ThemeColor('list.warningForeground'))
        : new vscode.ThemeIcon(r.template.icon);
      item.contextValue = r.drifted ? 'context.drifted' : 'context';
      item.command = { title: 'Reveal', command: 'notebookContext.reveal', arguments: [el] };
      item.tooltip = this.tooltipFor(r);
      return item;
    }
    const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
    item.description = el.description;
    item.iconPath = el.icon;
    item.command = el.command;
    item.tooltip = el.tooltip;
    item.contextValue = 'detail';
    return item;
  }

  private tooltipFor(r: ContextRecord): vscode.MarkdownString {
    const h = r.parsed.header;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${r.template.emoji} ${r.template.title} · ${h.id}**\n\n`);
    for (const f of r.parsed.fields) {
      md.appendMarkdown(`**${f.label}:** ${f.value || '—'}\n\n`);
    }
    md.appendMarkdown(`---\n\ncreated ${h.created}`);
    if (h.updated !== h.created) {
      md.appendMarkdown(` · updated ${h.updated}`);
    }
    md.appendMarkdown(r.target ? ` · cell ${r.target.index}` : ' · linked cell not found');
    if (r.drifted) {
      md.appendMarkdown(`\n\n$(warning) code changed since capture`);
    }
    return md;
  }

  dispose(): void {
    this._onDidChange.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
