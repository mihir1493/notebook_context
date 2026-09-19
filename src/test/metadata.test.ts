import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countFilled,
  formatTimestamp,
  generateId,
  hashSource,
  parseContextCell,
  parseTimestamp,
  renderContextCell,
  setHeaderField,
  splitContextCell,
  stripUntouchedHints,
} from '../metadata';
import { getTemplate, TEMPLATES } from '../templates';
import { ContextHeader } from '../types';

const header: ContextHeader = {
  id: 'CTX-001',
  type: 'experiment',
  created: '2026-09-19 14:03:22 +05:30',
  updated: '2026-09-19 14:03:22 +05:30',
  notebookPath: 'analysis/churn.ipynb',
  cellId: 'abc123',
  cellIndex: 5,
  cellHash: 'sha256:0123456789ab',
};
const experiment = getTemplate('experiment')!;

describe('hashSource', () => {
  it('ignores trailing whitespace and line endings', () => {
    assert.equal(hashSource('a = 1  \nb = 2\n'), hashSource('a = 1\r\nb = 2'));
  });
  it('changes when code changes', () => {
    assert.notEqual(hashSource('a = 1'), hashSource('a = 2'));
  });
  it('has the documented shape', () => {
    assert.match(hashSource('x'), /^sha256:[0-9a-f]{12}$/);
  });
});

describe('timestamps', () => {
  it('round-trips through format/parse', () => {
    const d = new Date(2026, 8, 19, 14, 3, 22);
    const s = formatTimestamp(d);
    assert.match(s, /^2026-09-19 14:03:22 [+-]\d{2}:\d{2}$/);
    assert.equal(parseTimestamp(s)?.getTime(), d.getTime());
  });
  it('parses timestamps without an offset as local time', () => {
    assert.equal(parseTimestamp('2026-01-02 03:04:05')?.getTime(), new Date(2026, 0, 2, 3, 4, 5).getTime());
  });
});

describe('generateId', () => {
  it('continues the sequence', () => {
    assert.equal(generateId(['CTX-001', 'CTX-007', 'CTX-ABCDEF'], 'sequential'), 'CTX-008');
    assert.equal(generateId([], 'sequential'), 'CTX-001');
  });
  it('produces random ids that avoid collisions', () => {
    const id = generateId([], 'random');
    assert.match(id, /^CTX-[23456789A-HJ-NP-Z]{6}$/);
  });
});

describe('render → parse', () => {
  it('renders every template with hints and parses back as empty', () => {
    for (const tpl of TEMPLATES) {
      const text = renderContextCell(tpl, { ...header, type: tpl.type });
      const parsed = parseContextCell(text);
      assert.ok(parsed, tpl.type);
      assert.equal(parsed.header.id, 'CTX-001');
      assert.equal(parsed.header.type, tpl.type);
      assert.equal(parsed.header.cellIndex, 5);
      assert.equal(parsed.header.cellHash, header.cellHash);
      assert.equal(parsed.header.cellId, 'abc123');
      assert.deepEqual(parsed.fields.map((f) => f.label), tpl.fields.map((f) => f.label));
      assert.equal(countFilled(parsed.fields, tpl), 0, `${tpl.type} should count no filled fields`);
      assert.match(parsed.title, /not filled in yet/);
    }
  });

  it('keeps user values, including multi-line ones', () => {
    const text = renderContextCell(experiment, header, {
      values: { Hypothesis: 'Recency features lift AUC', Change: 'added days_since_last_order\n\n- also dropped zip', Result: '', Decision: 'keep' },
    });
    const parsed = parseContextCell(text)!;
    assert.equal(parsed.title, 'Recency features lift AUC');
    assert.equal(parsed.fields[1].value, 'added days_since_last_order\n\n- also dropped zip');
    assert.equal(parsed.fields[2].value, '');
    assert.equal(countFilled(parsed.fields, experiment), 3);
  });

  it('omits the footer when asked', () => {
    assert.ok(!renderContextCell(experiment, header, { footer: false }).includes('<sub>'));
  });

  it('treats a template default as not-filled', () => {
    const tpl = getTemplate('assumption')!;
    const parsed = parseContextCell(renderContextCell(tpl, { ...header, type: 'assumption' }))!;
    assert.equal(parsed.fields.find((f) => f.label === 'Validation status')?.value, 'Unvalidated');
    assert.equal(countFilled(parsed.fields, tpl), 0);
  });
});

describe('stripUntouchedHints', () => {
  it('replaces untouched hints and leaves edited fields alone', () => {
    const text = renderContextCell(experiment, header).replace(
      `_${experiment.fields[0].hint}_`,
      'Recency features lift AUC'
    );
    const stripped = stripUntouchedHints(text, experiment);
    const parsed = parseContextCell(stripped)!;
    assert.equal(parsed.fields[0].value, 'Recency features lift AUC');
    assert.ok(!stripped.includes(`_${experiment.fields[1].hint}_`));
    assert.ok(stripped.includes('**Change:** —'));
  });
});

describe('setHeaderField', () => {
  it('updates an existing key', () => {
    const text = renderContextCell(experiment, header);
    const updated = setHeaderField(text, 'updated_timestamp', '2026-09-20 09:00:00 +05:30');
    assert.equal(parseContextCell(updated)!.header.updated, '2026-09-20 09:00:00 +05:30');
    assert.equal(parseContextCell(updated)!.header.created, header.created);
  });
  it('appends a missing key inside the comment', () => {
    const text = renderContextCell(experiment, { ...header, cellId: undefined });
    const updated = setHeaderField(text, 'cell_id', 'zzz');
    assert.equal(parseContextCell(updated)!.header.cellId, 'zzz');
    assert.ok(splitContextCell(updated)!.headerText.endsWith('-->'));
  });
  it('does not change the body hash', () => {
    const text = renderContextCell(experiment, header);
    const updated = setHeaderField(text, 'cell_hash', 'sha256:ffffffffffff');
    assert.equal(parseContextCell(text)!.bodyHash, parseContextCell(updated)!.bodyHash);
  });
});

describe('parseContextCell robustness', () => {
  it('accepts the "# @key:" spelling and blank lines inside the header', () => {
    const text = [
      '<!-- notebook-context',
      '# @context_id: CTX-042',
      '',
      '# @type: decision',
      '# @created_timestamp: 2026-09-19 10:00:00 +00:00',
      '# @cell_index: 3',
      '-->',
      '### ⚖️ Decision · CTX-042',
      '',
      '**Decision:** Use LightGBM',
      '**Why:** faster to iterate',
    ].join('\n');
    const parsed = parseContextCell(text)!;
    assert.equal(parsed.header.id, 'CTX-042');
    assert.equal(parsed.header.updated, parsed.header.created);
    assert.equal(parsed.title, 'Use LightGBM');
    assert.equal(parsed.fields.length, 2);
  });
  it('rejects cells without a header or with an unknown type', () => {
    assert.equal(parseContextCell('# Just a heading'), undefined);
    assert.equal(parseContextCell('<!-- notebook-context\n@context_id: X\n@type: nope\n-->'), undefined);
  });
});
