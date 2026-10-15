import type { WorkspaceSkillRecord } from '@assistant/persistence';

const INVENTORY_INTENT =
  /(?:\b(?:what|which|list|show|tell\s+me\s+about)\b[\s\S]{0,100}\b(?:my\s+)?(?:saved|learned)\s+skills?\b|\b(?:my\s+)?(?:saved|learned)\s+skills?\b[\s\S]{0,80}\b(?:have|list|show|could\s+help|help)\b)/i;
const POSITIVE_MUTATION =
  /(?:^|[.!?;]\s*|\b(?:and|then)\s+)(?:please\s+)?(?:use|apply|follow|run|execute|edit|change|delete|remove|save|create)\b/i;

export type SavedSkillInventoryIntent =
  | { kind: 'all' }
  | { kind: 'relevant'; scope: string; labels: string[]; terms: string[] };

/** An owner asks to inspect saved skills, rather than apply one as advice. */
export function requestedSavedSkillInventory(ownerAuthoredText: string): boolean {
  return savedSkillInventoryIntent(ownerAuthoredText) !== null;
}

const SCOPE_LABELS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'planning', pattern: /\b(?:plan|planning|organize|organise|agenda|daily)\b/i },
  { label: 'scheduling', pattern: /\b(?:calendar|schedule|time.?block|meeting|availability)\b/i },
  {
    label: 'prioritization',
    pattern: /\b(?:priorit(?:y|ies|ize|ise)|urgent|importance|deadline)\b/i,
  },
  { label: 'task management', pattern: /\b(?:tasks?|checklist|backlog|follow.?ups?)\b/i },
  { label: 'focus', pattern: /\b(?:focus|deep work|concentration|distraction)\b/i },
];
const INVENTORY_LIMIT = 50;
const SCOPE_REQUEST =
  /\b(?:could|would|can)\s+help\s+(?:me\s+)?(?:to\s+)?(.+?)(?:[?.!]|$)|\bhelp\s+(?:me\s+)?(?:with|plan|organize|organise|prioritize|prioritise)\s+(.+?)(?:[?.!]|$)/i;
const SCOPE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'help',
  'i',
  'in',
  'me',
  'my',
  'of',
  'on',
  'that',
  'the',
  'to',
  'what',
  'which',
  'with',
]);

export function savedSkillInventoryIntent(text: string): SavedSkillInventoryIntent | null {
  if (!INVENTORY_INTENT.test(text) || POSITIVE_MUTATION.test(text)) return null;
  const match = SCOPE_REQUEST.exec(text);
  const scope = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!scope) return { kind: 'all' };
  const labels = requestedScopeLabels(scope);
  const terms =
    scope
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length > 2 && !SCOPE_STOP_WORDS.has(term)) ?? [];
  if (labels.length === 0 && terms.length === 0) return { kind: 'all' };
  return { kind: 'relevant', scope, labels, terms };
}

/**
 * Return a bounded, relevance-filtered view. Procedure text is used only to
 * establish scope; it is never included in the answer or applied to the task.
 */
export function renderRelevantSavedSkills(
  skills: WorkspaceSkillRecord[],
  intent: SavedSkillInventoryIntent = { kind: 'all' },
): string {
  const active = skills
    .filter((skill) => !skill.deprecated)
    .flatMap((skill) => {
      const scope = `${skill.name}\n${skill.preconditions}\n${skill.steps}\n${skill.gotchas}`;
      const labels = scopeLabels(scope);
      const termMatches = intent.kind === 'relevant' ? matchingTerms(scope, intent.terms) : [];
      if (
        intent.kind === 'relevant' &&
        !labels.some((label) => intent.labels.includes(label)) &&
        termMatches.length === 0
      )
        return [];
      return [{ skill, labels, termMatches }];
    })
    .sort(
      (left, right) =>
        Number(right.skill.ownerAuthored) - Number(left.skill.ownerAuthored) ||
        right.termMatches.length - left.termMatches.length ||
        right.labels.length - left.labels.length ||
        right.skill.updatedAt.getTime() - left.skill.updatedAt.getTime() ||
        left.skill.id.localeCompare(right.skill.id),
    );
  const matches = active.slice(0, INVENTORY_LIMIT);

  if (matches.length === 0) {
    if (intent.kind === 'all') return 'There are no active saved skills in the library.';
    const requestedScope = safeText(intent.scope);
    return `I could not find an active saved skill whose recorded scope matches ${requestedScope}. This is a bounded lookup of saved metadata, not a guarantee that no other skill could help.`;
  }

  const list = matches
    .map(({ skill, labels }) => {
      const savedScope = safeText(skill.preconditions);
      const description = savedScope
        ? `saved scope: “${savedScope}”${labels.length ? ` (related to ${labels.join(', ')})` : ''}`
        : labels.length
          ? `saved scope indicates ${labels.join(', ')}`
          : 'saved scope is not described';
      return `- **${safeText(skill.name)}** — ${description}. (${skill.ownerAuthored ? 'Saved by you' : 'Learned from use'}.)`;
    })
    .join('\n');
  const heading =
    intent.kind === 'all'
      ? 'Here are your active saved skills:'
      : `These active saved skills have recorded scope relevant to ${safeText(intent.scope)}:`;
  const countNote =
    active.length > INVENTORY_LIMIT
      ? `Showing ${INVENTORY_LIMIT} of ${active.length} active skills.`
      : `Showing ${active.length} active skill${active.length === 1 ? '' : 's'}.`;
  return `${heading}\n\n${list}\n\n${countNote} I inspected saved descriptions only and did not apply any skill.`;
}

function scopeLabels(scope: string): string[] {
  return SCOPE_LABELS.filter(({ pattern }) => pattern.test(scope)).map(({ label }) => label);
}

function requestedScopeLabels(scope: string): string[] {
  const labels = scopeLabels(scope);
  if (
    labels.includes('planning') &&
    /\b(?:day|daily|week|weekly|busy|schedule|agenda)\b/i.test(scope)
  ) {
    for (const label of ['scheduling', 'prioritization', 'task management', 'focus'])
      if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function matchingTerms(text: string, terms: string[]): string[] {
  const words = new Set(text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []);
  return terms.filter((term) => words.has(term));
}

function safeText(value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[\\`*_{}[\]()#+|]/g, '\\$&')
    .slice(0, 120)
    .trim();
}
