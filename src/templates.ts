import { ContextTemplate, ContextType } from './types';

/**
 * Six minimal templates. Each field's hint is written as the question a
 * teammate (or future-you) would actually ask when reading the cell cold.
 */
export const TEMPLATES: ContextTemplate[] = [
  {
    type: 'experiment',
    emoji: '🧪',
    title: 'Experiment',
    description: 'You changed something and want to record whether it helped',
    icon: 'beaker',
    fields: [
      { label: 'Hypothesis', hint: 'What you expect to happen and why (e.g. recency features should lift AUC because churn is time-sensitive)' },
      { label: 'Change', hint: 'Exactly what differs from the baseline: features, hyperparameters, data slice, model' },
      { label: 'Result', hint: 'Metric before → after, on which split. Numbers, not adjectives' },
      { label: 'Decision', hint: 'Keep / revert / iterate — and the next thing to try' },
    ],
  },
  {
    type: 'decision',
    emoji: '⚖️',
    title: 'Decision',
    description: 'You chose one path over others — record why before you forget',
    icon: 'law',
    fields: [
      { label: 'Decision', hint: 'What you chose, stated plainly' },
      { label: 'Why', hint: 'The reasoning, in one or two sentences' },
      { label: 'Evidence', hint: 'Numbers, plots, links — or say it was a judgment call' },
      { label: 'Alternatives', hint: "What else you considered and why you didn't pick it" },
      { label: 'Revisit if', hint: 'What would make you reopen this (more data, different metric, deadline passes)' },
    ],
  },
  {
    type: 'assumption',
    emoji: '🤔',
    title: 'Assumption',
    description: "Something you're treating as true without having verified it",
    icon: 'question',
    fields: [
      { label: 'Assumption', hint: 'What you are treating as true without having checked' },
      { label: 'Reason', hint: "Why it's reasonable to assume this right now" },
      { label: 'Risk', hint: 'What breaks downstream if it turns out to be wrong' },
      { label: 'Validation status', hint: 'Unvalidated / Validated (how?) / Invalidated (what happened?)', default: 'Unvalidated' },
    ],
  },
  {
    type: 'data-context',
    emoji: '🗂️',
    title: 'Data Context',
    description: 'What this data actually is, before anyone trusts a number from it',
    icon: 'database',
    fields: [
      { label: 'Dataset', hint: 'Source table / file / API, plus version or snapshot date' },
      { label: 'Grain', hint: 'One row = ? (e.g. one customer per calendar month)' },
      { label: 'Date range', hint: 'Period covered, and whether the last period is complete' },
      { label: 'Filters', hint: 'Rows excluded and why (test accounts, nulls, outliers)' },
      { label: 'Known limitations', hint: 'Missing values, leakage risk, sampling bias, stale dimensions' },
    ],
  },
  {
    type: 'result',
    emoji: '📈',
    title: 'Result',
    description: "A number worth remembering, and what it does and doesn't mean",
    icon: 'graph',
    fields: [
      { label: 'Metric', hint: 'What was measured, on which split / period' },
      { label: 'Value', hint: 'The number(s), with the baseline you compared against' },
      { label: 'Interpretation', hint: "What this means for the question you're actually answering" },
      { label: 'Caveats', hint: 'Why this could mislead: leakage, small n, cherry-picked window, seed luck' },
      { label: 'Next step', hint: 'What this result makes you do next' },
    ],
  },
  {
    type: 'note',
    emoji: '📝',
    title: 'General Note',
    description: 'Anything else worth telling future-you about this cell',
    icon: 'note',
    fields: [
      { label: 'Note', hint: 'Whatever future-you or a teammate needs to know about this cell' },
      { label: 'Follow-up', hint: 'Anything to come back to — leave as is if none' },
    ],
  },
];

const BY_TYPE = new Map<ContextType, ContextTemplate>(TEMPLATES.map((t) => [t.type, t]));

export function getTemplate(type: string): ContextTemplate | undefined {
  return BY_TYPE.get(type as ContextType);
}

export function isContextType(type: string): type is ContextType {
  return BY_TYPE.has(type as ContextType);
}
