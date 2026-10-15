import type { WorkspaceSkillRecord } from '@assistant/persistence';

const INVENTORY_INTENT =
  /(?:\b(?:what|which|list|show|tell\s+me\s+about)\b[\s\S]{0,100}\b(?:my\s+)?(?:saved|learned)\s+skills?\b|\b(?:my\s+)?(?:saved|learned)\s+skills?\b[\s\S]{0,80}\b(?:have|list|show|could\s+help|help)\b)/i;
const INVENTORY_MUTATION =
  /\b(?:use|apply|follow|run|execute|edit|change|delete|remove|save|create)\b/i;

/** An owner asks to inspect saved skills, rather than apply one as advice. */
export function requestedSavedSkillInventory(ownerAuthoredText: string): boolean {
  return INVENTORY_INTENT.test(ownerAuthoredText) && !INVENTORY_MUTATION.test(ownerAuthoredText);
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
const INVENTORY_LIMIT = 5;

/**
 * Return a bounded, relevance-filtered view. Procedure text is used only to
 * establish scope; it is never included in the answer or applied to the task.
 */
export function renderRelevantSavedSkills(skills: WorkspaceSkillRecord[]): string {
  const matches = skills
    .filter((skill) => !skill.deprecated)
    .flatMap((skill) => {
      const scope = `${skill.name}\n${skill.preconditions}\n${skill.steps}\n${skill.gotchas}`;
      const labels = SCOPE_LABELS.filter(({ pattern }) => pattern.test(scope)).map(
        ({ label }) => label,
      );
      if (labels.length === 0) return [];
      return [{ skill, labels }];
    })
    .sort(
      (left, right) =>
        Number(right.skill.ownerAuthored) - Number(left.skill.ownerAuthored) ||
        right.labels.length - left.labels.length ||
        right.skill.updatedAt.getTime() - left.skill.updatedAt.getTime() ||
        left.skill.id.localeCompare(right.skill.id),
    )
    .slice(0, INVENTORY_LIMIT);

  if (matches.length === 0)
    return 'I could not find an active saved skill whose recorded scope indicates planning, scheduling, prioritization, task management, or focus. This is a relevance-filtered lookup, not a complete audit of every possible use.';

  const list = matches
    .map(({ skill, labels }) => {
      const savedScope = safeText(skill.preconditions);
      const description = savedScope
        ? `saved scope: “${savedScope}” (related to ${labels.join(', ')})`
        : `saved scope indicates ${labels.join(', ')}`;
      return `- **${safeText(skill.name)}** — ${description}. (${skill.ownerAuthored ? 'Saved by you' : 'Learned from use'}.)`;
    })
    .join('\n');
  return `These active saved skills have recorded scope that may help with planning a busy day:\n\n${list}\n\nThis relevance-filtered view shows up to ${INVENTORY_LIMIT} matches; it does not claim to be a complete inventory. I only inspected the saved descriptions and did not apply any skill.`;
}

function safeText(value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/[\\`*_{}[\]()#+|]/g, '\\$&')
    .slice(0, 120)
    .trim();
}
