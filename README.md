# Notebook Context 🧠

Capture the *reasoning* behind your Jupyter notebook code — without leaving the notebook — and backtrack later to see what you decided, what you assumed, and what has changed since.

Notebooks record **what** ran. They rarely record **why**: why this feature was dropped, why the date range stops in March, what the AUC was *before* the change, which alternatives were rejected. Six weeks later that context is gone, and a notebook full of code is hard to trust and hard to hand off (to a teammate or an AI agent).

Notebook Context puts that reasoning right above the code it explains, as ordinary markdown cells with a little structure, then tracks whether the code has drifted away from it.

## How it works

1. Focus a code cell and press **`Ctrl+Alt+C`** — or click **🧠 Capture Context** in the cell toolbar.
2. Pick one of six context types (type `1`–`6` or a name):

   | | Type | Use it when… |
   |---|---|---|
   | 1 | 🧪 **Experiment** | you changed something and want to record whether it helped |
   | 2 | ⚖️ **Decision** | you chose one path over others — record why before you forget |
   | 3 | 🤔 **Assumption** | something you're treating as true without having verified it |
   | 4 | 🗂️ **Data Context** | what this data actually *is*, before anyone trusts a number from it |
   | 5 | 📈 **Result** | a number worth remembering, and what it does and doesn't mean |
   | 6 | 📝 **General Note** | anything else worth telling future-you about this cell |

3. A markdown cell with the template appears **above** the code cell, already in edit mode. Each field shows an italic hint; type over the ones you want.
4. Press **`Ctrl+Alt+C`** again (or click 🧠 on that cell) to **save**: untouched hints are cleared to `—`, the timestamp is updated, and the cell renders.

Prefer being asked one question at a time? Set `notebookContext.captureMode` to `guided` and each field becomes an input box; the finished cell is inserted when you answer the last one.

### The templates

Each template is deliberately short. Fields are written as the question a teammate would ask reading the cell cold.

| Type | Fields |
|---|---|
| 🧪 Experiment | Hypothesis · Change · Result · Decision |
| ⚖️ Decision | Decision · Why · Evidence · Alternatives · Revisit if |
| 🤔 Assumption | Assumption · Reason · Risk · Validation status (defaults to *Unvalidated*) |
| 🗂️ Data Context | Dataset · Grain · Date range · Filters · Known limitations |
| 📈 Result | Metric · Value · Interpretation · Caveats · Next step |
| 📝 General Note | Note · Follow-up |

*Revisit if* on Decision is the one addition beyond the classic four: most bad DS decisions were fine when made and just never got re-examined when the conditions changed.

### What a context cell looks like

```markdown
<!-- notebook-context
@context_id: CTX-002
@type: experiment
@created_timestamp: 2026-09-15 16:40:51 +05:30
@updated_timestamp: 2026-09-15 16:40:51 +05:30
@notebook_path: examples/churn_demo.ipynb
@cell_id: 4f1c…            ← nbformat cell id, when the notebook has them
@cell_index: 4
@cell_hash: sha256:7dfd102101d4
-->

### 🧪 Experiment · CTX-002

**Hypothesis:** Recency matters more than volume for churn — days-since-last-order should lift AUC

**Change:** baseline uses only `n_orders` and `revenue`

**Result:** —

**Decision:** —

<sub>🧠 CTX-002 · created 2026-09-15 16:40:51 +05:30 · linked to cell 4</sub>
```

The metadata block is an HTML comment, so it's invisible when rendered (in VS Code, JupyterLab and GitHub) but greppable in the `.ipynb`. The same data — plus a **snapshot of the linked cell's code** — is stored in the cell's ipynb metadata under `notebook_context`, which is what powers the diff view.

## Backtracking: what changed, when

Every capture hashes the code cell it describes. From then on the extension compares that hash with the cell's current content.

- **Cell status bar** — every context cell shows `🧠 CTX-002 · Experiment`, and every code cell with context shows `🧠 2 contexts`. When the code has moved on: `⚠ code changed`. Click for actions.
- **Timeline view** (🧠 icon in the activity bar) — all context in the active notebook, newest first. Group it by **type**, or by **cell** to read the evolution of a single piece of code top-down. Expand an entry to see its fields, timestamps and drift status; click to jump to the cell.
- **Show Code Diff Since Capture** — opens a diff editor: the code as it was when you wrote the context ↔ the code now.
- **Mark Linked Code as Current** — you read the diff, the context still holds (or you updated it): accept the new code as the baseline. Hash, snapshot and `@updated_timestamp` refresh.
- **Export Context Log…** — writes `<notebook>.context.md` (or `.json`) next to the notebook: a timeline table plus every context with its fields and code snapshots. Drop it into a PR, a handoff doc, or an AI agent's context window.

Capturing a second context on the same cell simply stacks another cell above it, so an Experiment → Result → Decision chain reads naturally in the notebook and in the "group by cell" timeline.

If you save the notebook with `Cmd+S` after editing a context cell, `@updated_timestamp` is refreshed automatically (only when the body actually changed).

## Commands & keys

| Command | Where |
|---|---|
| 🧠 Capture Context / Save | `Ctrl+Alt+C`, cell toolbar, command palette |
| Show Code Diff Since Capture | timeline item, cell status bar menu, palette |
| Mark Linked Code as Current | timeline item (when drifted), cell status bar menu |
| Reveal Linked Code Cell | timeline item |
| Export Context Log… | timeline title bar, palette |
| Group Timeline By… | timeline title bar |

`Ctrl+Alt+C` is unused by VS Code and by Jupyter's command-mode letter shortcuts. On keyboard layouts where `Ctrl+Alt` acts as AltGr, rebind `notebookContext.capture` in Keyboard Shortcuts.

## Settings

| Setting | Default | |
|---|---|---|
| `notebookContext.captureMode` | `template` | `template` inserts an editable template cell; `guided` asks per field in input boxes |
| `notebookContext.idStyle` | `sequential` | `CTX-001, CTX-002…` per notebook, or `random` (`CTX-7F3K2A`) for merge-safety |
| `notebookContext.storeCodeSnapshot` | `true` | keep the linked cell's code in metadata for later diffing |
| `notebookContext.autoUpdateTimestamp` | `true` | refresh `@updated_timestamp` on notebook save when the body changed |
| `notebookContext.showFooter` | `true` | render the small `<sub>` footer line |
| `notebookContext.timeline.groupBy` | `time` | `time` · `type` · `cell` |

## Development

```bash
npm install
npm run compile      # or: npm run watch
npm test             # unit tests for templates / metadata parsing (node:test)
```

Press **F5** to launch an Extension Development Host with `examples/churn_demo.ipynb` — it contains three pre-made contexts, one of which (CTX-002) is deliberately stale so you can try the diff.

```bash
npm run package      # builds notebook-context-0.1.0.vsix; install via "Extensions: Install from VSIX…"
```

## Design notes

- **Plain markdown, no custom renderer.** Context cells are ordinary markdown, so notebooks stay readable in JupyterLab, GitHub and nbviewer, and `nbconvert` exports them. The extension is a convenience layer; nothing breaks without it.
- **Adjacency is the link.** A context describes the first non-context cell below it. The stored `cell_id` (when present) takes priority so a moved cell can still be found; `cell_index` is the last resort.
- **The type picker is a QuickPick, not an in-cell widget.** VS Code notebooks don't allow interactive controls inside a markdown cell (command links are blocked for security), so the native picker is the closest thing to "select 1–6 inside the notebook".
