import {
  decideOwnerEmailObligation,
  listOwnerEmailObligations,
} from '@assistant/application/email-obligations';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getEmailObligationRepository } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const obligations = await listOwnerEmailObligations(getEmailObligationRepository());
  return mobileJson({ obligations });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, [
    'channelMessageId',
    'decision',
    'expectedVersion',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as {
    channelMessageId?: unknown;
    expectedVersion?: unknown;
    decision?: unknown;
  } | null;
  const channelMessageId = typeof body?.channelMessageId === 'string' ? body.channelMessageId : '';
  const expectedVersion = body?.expectedVersion;
  const decision = body?.decision;
  if (!channelMessageId || !Number.isInteger(expectedVersion) || (expectedVersion as number) < 0) {
    return mobileJson(
      { error: 'channelMessageId and expectedVersion are required' },
      { status: 400 },
    );
  }
  if (!['confirm_open', 'resolve', 'snooze', 'reopen'].includes(String(decision))) {
    return mobileJson(
      { error: 'decision must be confirm_open, resolve, snooze, or reopen' },
      { status: 400 },
    );
  }
  const now = new Date();
  const changed = await decideOwnerEmailObligation(getEmailObligationRepository(), {
    channelMessageId,
    expectedVersion: expectedVersion as number,
    decision: decision as 'confirm_open' | 'resolve' | 'snooze' | 'reopen',
    now,
    ...(decision === 'snooze' ? { snoozedUntil: new Date(now.getTime() + 24 * 3600_000) } : {}),
  });
  return changed
    ? mobileJson({ ok: true })
    : mobileJson(
        { error: 'The source changed or the decision is stale. Reload the current thread.' },
        { status: 409 },
      );
}
