import type { GoalInput } from '@assistant/application/goals';

export type GoalTargetDateResult = { ok: true; value: Date | null } | { ok: false; error: string };

/** Parse date-only goal targets without allowing Date to normalize invalid days. */
export function parseGoalTargetDate(value: unknown): GoalTargetDateResult {
  if (value == null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'Target date must be YYYY-MM-DD.' };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { ok: false, error: 'Target date must be YYYY-MM-DD.' };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, error: 'Target date is not valid.' };
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, error: 'Target date is not valid.' };
  }
  return { ok: true, value: date };
}

export function parseGoalInput(body: unknown): GoalInput | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { error: 'invalid goal body' };
  const value = body as Record<string, unknown>;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title) return { error: 'Title is required.' };
  const priority = typeof value.priority === 'number' ? value.priority : 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    return { error: 'Priority must be between 1 and 5.' };
  }

  const parsedTargetDate = parseGoalTargetDate(value.targetDate);
  if (!parsedTargetDate.ok) return { error: parsedTargetDate.error };

  const text = (key: string) => (typeof value[key] === 'string' ? value[key].trim() : '');
  return {
    title,
    description: text('description'),
    priority,
    targetDate: parsedTargetDate.value,
    progress: text('progress'),
    nextAction: text('nextAction'),
    mirrorToPrimary: value.mirrorToPrimary === true,
  };
}
