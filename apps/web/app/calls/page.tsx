import { listCalls } from '@assistant/application/calls';
import { PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import { requireOwner } from '@/auth';
import { formatUsd, relativeTime } from '@/lib/format';
import { getCallsPorts } from '@/lib/server';
import {
  Badge,
  cardInteractiveClass,
  cardShellClass,
  cardTitleClass,
  EmptyState,
  MetaLine,
  PageHeader,
  PageShell,
} from '@/lib/ui';
import { CALL_OUTCOME, CALL_STATUS, callDuration } from './labels';

export const metadata = { title: 'Calls' };

export const dynamic = 'force-dynamic';

export default async function CallsPage() {
  await requireOwner();
  const calls = await listCalls(await getCallsPorts());
  const now = new Date();
  return (
    <PageShell size="reading">
      <AutoRefresh intervalMs={5_000} />
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Calls"
        intro="Phone calls the assistant placed for you. Every call opens by saying it is an AI assistant, and you approve each one first."
      />
      {calls.length === 0 ? (
        <EmptyState icon={<PhoneCall className="size-5" />}>
          No calls yet. Ask the assistant in chat to call someone for you.
        </EmptyState>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {calls.map((call) => {
            const status = CALL_STATUS[call.status] ?? {
              label: call.status,
              tone: 'neutral' as const,
            };
            return (
              <li key={call.id}>
                <Link
                  href={`/calls/${call.id}`}
                  className={`${cardShellClass} ${cardInteractiveClass} block px-4 py-4 sm:px-5`}
                >
                  <p className={`flex flex-wrap items-center gap-2 ${cardTitleClass}`}>
                    {call.contactName ?? call.to}
                    <Badge tone={status.tone} size="xs">
                      {status.label}
                    </Badge>
                    {call.openCheckin ? (
                      <Badge tone="amber" size="xs">
                        Needs your answer
                      </Badge>
                    ) : null}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted">
                    {call.summary ?? call.brief.goal}
                  </p>
                  <MetaLine
                    className="mt-2"
                    segments={[
                      relativeTime(call.createdAt, now),
                      call.outcome ? (CALL_OUTCOME[call.outcome] ?? call.outcome) : null,
                      callDuration(call.durationSeconds),
                      call.costUsd ? formatUsd(call.costUsd) : null,
                    ].filter(Boolean)}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PageShell>
  );
}
