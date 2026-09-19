import * as vscode from 'vscode';
import { formatTimestamp, parseTimestamp } from './metadata';
import { ContextRecord, firstCodeLine, indexNotebook } from './notebookUtils';

/**
 * Writes every context in the notebook to a sibling file. Markdown is meant
 * for humans and for pasting into an AI agent's context; JSON is for tooling.
 */
export async function exportContextLog(notebook: vscode.NotebookDocument): Promise<void> {
  const records = [...indexNotebook(notebook)].sort(
    (a, b) => (parseTimestamp(a.parsed.header.created)?.getTime() ?? 0) - (parseTimestamp(b.parsed.header.created)?.getTime() ?? 0)
  );
  if (records.length === 0) {
    void vscode.window.showInformationMessage('Notebook Context: nothing to export — no context cells in this notebook.');
    return;
  }
  const format = await vscode.window.showQuickPick(
    [
      { label: 'Markdown', description: 'Readable log with code snapshots — good for teammates and AI agents', value: 'md' },
      { label: 'JSON', description: 'Structured records for tooling', value: 'json' },
    ],
    { title: 'Export context log', placeHolder: `${records.length} contexts from ${vscode.workspace.asRelativePath(notebook.uri)}` }
  );
  if (!format) {
    return;
  }
  const base = notebook.uri.path.replace(/\.ipynb$/i, '');
  const outUri = notebook.uri.with({ path: `${base}.context.${format.value}` });
  const content = format.value === 'md' ? toMarkdown(notebook, records) : toJson(notebook, records);
  await vscode.workspace.fs.writeFile(outUri, Buffer.from(content, 'utf8'));
  const doc = await vscode.workspace.openTextDocument(outUri);
  await vscode.window.showTextDocument(doc, { preview: false });
}

function toMarkdown(notebook: vscode.NotebookDocument, records: ContextRecord[]): string {
  const rel = vscode.workspace.asRelativePath(notebook.uri, false);
  const drifted = records.filter((r) => r.drifted).length;
  const out: string[] = [
    `# Context log — ${rel.split('/').pop()}`,
    '',
    `Notebook: \`${rel}\`  `,
    `Exported: ${formatTimestamp()}  `,
    `Contexts: ${records.length}${drifted ? ` (${drifted} where the code changed after capture)` : ''}`,
    '',
    '## Timeline',
    '',
    '| When | ID | Type | Summary | Cell | Code since capture |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of records) {
    const h = r.parsed.header;
    out.push(
      `| ${h.created.slice(0, 16)} | ${h.id} | ${r.template.emoji} ${r.template.title} | ${escapeCell(r.parsed.title)} | ` +
        `${r.target ? r.target.index : '?'} | ${r.target ? (r.drifted ? '⚠ changed' : 'unchanged') : 'not found'} |`
    );
  }
  out.push('', '## Contexts', '');
  for (const r of records) {
    const h = r.parsed.header;
    out.push(`### ${h.id} · ${r.template.emoji} ${r.template.title}`, '');
    out.push(`- Created: ${h.created}` + (h.updated !== h.created ? `  ·  Updated: ${h.updated}` : ''));
    if (r.target) {
      out.push(
        `- Linked cell: ${r.target.index} — \`${firstCodeLine(r.target)}\`` +
          (r.drifted ? `  ·  ⚠ code changed since capture (${h.cellHash} → ${r.currentHash})` : `  ·  unchanged (${h.cellHash})`)
      );
    } else {
      out.push(`- Linked cell: not found (was cell ${h.cellIndex})`);
    }
    out.push('');
    for (const f of r.parsed.fields) {
      out.push(`**${f.label}:** ${f.value || '—'}`, '');
    }
    const snapshot = r.meta?.snapshot;
    if (snapshot !== undefined) {
      const lang = r.target?.document.languageId ?? 'python';
      out.push('<details><summary>Code at capture</summary>', '', '```' + lang, snapshot, '```', '', '</details>', '');
    }
    if (r.drifted && r.target) {
      const lang = r.target.document.languageId;
      out.push('<details><summary>Code now</summary>', '', '```' + lang, r.target.document.getText(), '```', '', '</details>', '');
    }
  }
  return out.join('\n');
}

function toJson(notebook: vscode.NotebookDocument, records: ContextRecord[]): string {
  return JSON.stringify(
    {
      notebook: vscode.workspace.asRelativePath(notebook.uri, false),
      exported: formatTimestamp(),
      contexts: records.map((r) => ({
        ...r.parsed.header,
        title: r.parsed.title,
        fields: Object.fromEntries(r.parsed.fields.map((f) => [f.label, f.value])),
        linkedCellIndex: r.target?.index ?? null,
        linkedCellFound: !!r.target,
        codeChangedSinceCapture: r.drifted,
        currentHash: r.currentHash ?? null,
        snapshot: r.meta?.snapshot ?? null,
        currentSource: r.target?.document.getText() ?? null,
      })),
    },
    null,
    2
  );
}

const escapeCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
