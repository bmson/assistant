import { createPostgresExecutionPersistence, type Db, type TaskRow } from '@assistant/db';
import type { ExecutionPersistence } from '@assistant/persistence';
import type { ActionEvidence } from './response-contract.js';
import { isDurableSave } from './saved-work-evidence.js';

export { isDurableSave } from './saved-work-evidence.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function savedWorkSummary(evidence: ActionEvidence[]): string | undefined {
  const seen = new Set<string>();
  const saved = evidence.filter(isDurableSave).filter((item) => {
    const args = object(item.args);
    const result = object(item.result);
    const key =
      item.toolName === 'memory.save'
        ? typeof args.content === 'string'
          ? `memory:${args.subject ?? ''}:${args.content}`
          : undefined
        : typeof result.person === 'string' && args.month !== undefined && args.day !== undefined
          ? `occasion:${result.person}:${args.kind}:${args.month}:${args.day}`
          : undefined;
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const facts = saved.filter((item) => item.toolName === 'memory.save');
  const occasions = saved.filter((item) => item.toolName === 'occasions.save');
  const lines: string[] = [];
  if (facts.length) {
    lines.push(
      `Saved ${facts.length} ${facts.length === 1 ? 'entry' : 'entries'} to long-term memory.`,
    );
    for (const fact of facts.slice(0, 3)) {
      const content = object(fact.args).content;
      if (typeof content === 'string')
        lines.push(`- ${content.slice(0, 400)}${content.length > 400 ? '…' : ''}`);
    }
  }
  if (occasions.length) {
    const names = [
      ...new Set(
        occasions
          .map((item) => object(item.result).person)
          .filter((name): name is string => typeof name === 'string' && name.length > 0),
      ),
    ];
    const birthdays = occasions.every((item) => object(item.args).kind === 'birthday');
    lines.push(
      `Saved or updated ${occasions.length} ${birthdays ? 'birthday' : 'occasion'} ${occasions.length === 1 ? 'entry' : 'entries'} in People${names.length ? `: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}` : ''}.`,
    );
  }
  return lines.length ? lines.join('\n') : undefined;
}

export function isSaveStatusQuestion(text: string): boolean {
  // Deliberately narrow: this is a receipt lookup, never authority to save or
  // replay a write. Accept the common "was it save" typo from the live report.
  return (
    /^(?:was|is|has)\s+(?:it|that|this)\s+(?:been\s+)?(?:save[d]?|stored|remembered)(?:\s+(?:in|to)\s+(?:the\s+)?(?:long[- ]term\s+)?memory)?[?.!\s]*$/i.test(
      text.trim(),
    ) ||
    /^did you (?:save|store|remember) (?:it|that|this)(?:\s+(?:in|to)\s+(?:long[- ]term\s+)?memory)?[?.!\s]*$/i.test(
      text.trim(),
    )
  );
}

export function isMemoryWriteRequest(text: string): boolean {
  if (isSaveStatusQuestion(text)) return false;
  if (
    /\b(?:do not|don't|never)\s+(?:save|remember|store|add|update|correct|attach|link)\b/i.test(
      text,
    )
  )
    return false;
  return /\b(?:remember (?:this|these|those|that|it|our|my|the)|for you to remember|(?:save|store|add|update|correct|attach|link)[\s\S]{0,100}(?:memory|profile)|birthdays?[\s\S]{0,80}update)\b/i.test(
    text,
  );
}

export function saveStatusResponse(evidence: ActionEvidence[], status: string): string {
  const summary = savedWorkSummary(evidence);
  if (!summary)
    return "I found no confirmed memory or occasion save in the previous request's tool records. The earlier reply alone is not proof that anything was saved. No new changes were made by this check.";
  const incomplete = status !== 'done';
  return `${incomplete ? 'Partly. ' : ''}The previous request recorded these saves:\n\n${summary}${incomplete ? '\n\nThat request did not finish, so this does not confirm the whole list was saved.' : ''}\n\nThis checks the earlier save receipts; it does not make a new save or verify that the records have not since been edited or removed.`;
}

/** Select the preceding owner turn, never an unrelated old successful save. */
export async function previousSaveStatus(
  source: Db | Pick<ExecutionPersistence, 'tasks' | 'executionEvidence'>,
  task: TaskRow,
): Promise<string> {
  if (!task.conversationId)
    return 'I cannot identify the earlier request to check its save receipts.';
  const persistence = 'tasks' in source ? source : createPostgresExecutionPersistence(source);
  const preceding = await persistence.tasks.precedingOwnerTasks({
    agentId: task.agentId,
    conversationId: task.conversationId,
    taskType: task.type,
    createdBefore: task.createdAt,
    limit: 10,
  });
  const previous = preceding.find((row) => {
    const text = object(object(row.trigger).payload).text;
    return typeof text === 'string' && !isSaveStatusQuestion(text);
  });
  if (!previous)
    return 'I could not identify the earlier request to check its save receipts. Which request do you mean?';
  const evidence = await persistence.executionEvidence.taskEvidence({
    agentId: task.agentId,
    taskId: previous.id,
  });
  return saveStatusResponse(evidence, previous.status);
}

export function stepLimitResponse(maxSteps: number, evidence: ActionEvidence[]): string {
  const saved = savedWorkSummary(evidence);
  const calls = evidence.filter((item) => item.fromCurrentTask !== false);
  const completed = calls.filter(
    (item) =>
      item.status === 'succeeded' &&
      object(item.result).ok !== false &&
      object(item.result).saved !== false &&
      !(
        typeof object(item.result).status === 'number' && Number(object(item.result).status) >= 400
      ) &&
      object(item.result).deliveryStatus !== 'unknown',
  );
  const progress =
    saved ??
    (completed.length
      ? `${completed.length} tool ${completed.length === 1 ? 'call completed' : 'calls completed'} (${[...new Set(completed.map((item) => item.toolName))].join(', ')}), but the request is not finished.`
      : 'No successful result was recorded for this attempt.');
  return `I stopped after ${maxSteps} steps without finishing.\n\n${progress}\n\nThe remaining work has not been completed. Ask me to continue from these results; I should check what already exists before repeating any changes.`;
}
