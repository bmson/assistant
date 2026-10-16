/**
 * Tools that only inspect or rewrite the assistant's own bookkeeping do not
 * prove that an unattended goal session advanced the owner's outcome.
 */
const GOAL_BOOKKEEPING_TOOLS = new Set([
  'browser.plan',
  'conversations.search',
  'conversations.context',
  'goals.list',
  'goals.update_progress',
  'memory.recall',
  'mission.update',
  'owner.notify',
  'task.schedule',
  'workspace.list',
  'workspace.read',
]);

export function isGoalWorkEvidenceTool(toolName: string): boolean {
  return !GOAL_BOOKKEEPING_TOOLS.has(toolName);
}

export interface GoalToolEvidence {
  toolName: string;
  status: string;
  result: unknown;
  step?: number;
}

export interface GoalProgressCheckpoint {
  progress: string;
  nextAction: string;
}

/** Database success is not enough when a tool reports failure in its result payload. */
export function isGoalWorkEvidence(evidence: GoalToolEvidence): boolean {
  if (evidence.status !== 'succeeded' || !isGoalWorkEvidenceTool(evidence.toolName)) return false;
  if (!evidence.result || typeof evidence.result !== 'object') return true;
  const result = evidence.result as Record<string, unknown>;
  return (
    result.ok !== false &&
    !(typeof result.status === 'number' && result.status >= 400) &&
    result.deliveryStatus !== 'unknown'
  );
}

/**
 * Progress is fresh only when it was durably written in a later executor step than
 * the latest verified work. A progress call in the same batch cannot know the
 * result of that work and therefore does not count as its summary.
 */
export function needsGoalProgressUpdate(evidence: GoalToolEvidence[]): boolean {
  let latestWorkStep = -1;
  let latestProgressStep = -1;
  for (const row of evidence) {
    const step = row.step ?? 0;
    if (isGoalWorkEvidence(row)) latestWorkStep = Math.max(latestWorkStep, step);
    if (row.toolName === 'goals.update_progress' && row.status === 'succeeded') {
      latestProgressStep = Math.max(latestProgressStep, step);
    }
  }
  return latestWorkStep >= 0 && latestProgressStep <= latestWorkStep;
}

/**
 * Build the mandatory goal checkpoint without asking a model to invent one.
 *
 * Only ledger metadata is copied. Tool arguments, errors, and result prose are
 * deliberately excluded: they may contain untrusted page/email content, and a
 * generic but true checkpoint is safer than a detailed hallucination or a
 * prompt-injection payload persisted into the next goal session.
 */
export function buildGoalProgressCheckpoint(
  evidence: GoalToolEvidence[],
): GoalProgressCheckpoint | null {
  let latestProgressStep = -1;
  for (const row of evidence) {
    if (row.toolName === 'goals.update_progress' && row.status === 'succeeded') {
      latestProgressStep = Math.max(latestProgressStep, row.step ?? 0);
    }
  }

  // A progress call in the same step cannot describe that step's result, so
  // include work at the same step as the latest checkpoint as still unsaved.
  const unsavedWork = evidence.filter(
    (row) => isGoalWorkEvidence(row) && (row.step ?? 0) >= latestProgressStep,
  );
  if (unsavedWork.length === 0) return null;
  const unsavedFailures = evidence.filter(
    (row) =>
      isGoalWorkEvidenceTool(row.toolName) &&
      (row.status === 'failed' || (row.status === 'succeeded' && !isGoalWorkEvidence(row))) &&
      (row.step ?? 0) >= latestProgressStep,
  );

  const summarize = (rows: GoalToolEvidence[], verb: 'succeeded' | 'did not complete') => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const safeName = row.toolName.slice(0, 60);
      counts.set(safeName, (counts.get(safeName) ?? 0) + 1);
    }
    const tools = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
    const shown = tools
      .slice(0, 6)
      .map(([name, count]) => `${name} ${verb}${count === 1 ? '' : ` ${count} times`}`);
    const omitted = tools.length - shown.length;
    return [
      shown.join('; '),
      omitted > 0 ? `; ${omitted} more tool ${omitted === 1 ? 'type' : 'types'}` : '',
    ].join('');
  };
  const completed = summarize(unsavedWork, 'succeeded');
  const blocked = summarize(unsavedFailures, 'did not complete');
  const progress = [
    `Verified activity from completed tool results: ${completed}.`,
    blocked ? ` Blocked attempts: ${blocked}.` : '',
    ' Exact outputs are recorded in Activity.',
  ].join('');

  return {
    progress: progress.slice(0, 1000),
    nextAction: blocked
      ? 'Continue with a different source or approach. Do not repeat failed calls unchanged, and do not infer unverified facts.'
      : 'Continue with the next unfinished goal step. Re-check the source when exact details are needed, and do not infer unverified facts.',
  };
}
