import { getCall } from '@assistant/application/calls';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/app/auto-refresh';
import { requireOwner } from '@/auth';
import { formatDateTime, formatUsd } from '@/lib/format';
import { getAgentTimezone, getCallsPorts } from '@/lib/server';
import { Badge, Card, MetaLine, PageHeader, PageShell, SectionHeading } from '@/lib/ui';
import { CALL_OUTCOME, CALL_STATUS, callDuration } from '../labels';
import { LiveCallControls } from './live-controls';

export const metadata = { title: 'Call' };

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [call, timezone] = await Promise.all([
    getCall(await getCallsPorts(), id),
    getAgentTimezone(),
  ]);
  if (!call) notFound();
  const status = CALL_STATUS[call.status] ?? { label: call.status, tone: 'neutral' as const };

  return (
    <PageShell size="reading">
      {call.active ? (
        <AutoRefresh intervalMs={2_000} maxIntervalMs={2_000} refreshWhileEditing />
      ) : null}
      <PageHeader
        title={call.contactName ?? call.to}
        back={{ href: '/calls', label: 'Calls' }}
        intro={call.brief.goal}
        actions={
          <Badge tone={status.tone} uppercase>
            {status.label}
          </Badge>
        }
      />
      <MetaLine
        className="mt-3"
        segments={[
          call.to,
          formatDateTime(call.createdAt, timezone),
          callDuration(call.durationSeconds),
          call.costUsd ? formatUsd(call.costUsd) : null,
          call.voiceModel,
        ].filter(Boolean)}
      />

      {call.active ? (
        <Card className="mt-6">
          <LiveCallControls
            callId={call.id}
            checkin={
              call.openCheckin
                ? {
                    id: call.openCheckin.id,
                    question: call.openCheckin.question,
                    revision: call.openCheckin.revision,
                  }
                : null
            }
          />
        </Card>
      ) : null}

      {call.summary ? (
        <section className="mt-8">
          <SectionHeading
            title="Outcome"
            hint={call.outcome ? CALL_OUTCOME[call.outcome] : undefined}
          />
          <Card className="mt-3">
            <p className="text-base leading-7 text-strong">{call.summary}</p>
            {call.error ? <p className="mt-2 text-sm text-muted">{call.error}</p> : null}
          </Card>
        </section>
      ) : null}

      {call.notes.length > 0 ? (
        <section className="mt-8">
          <SectionHeading title="Noted on the call" count={call.notes.length} />
          <Card className="mt-3">
            <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-strong">
              {call.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      <section className="mt-8">
        <SectionHeading title="Transcript" count={call.transcript.length} />
        <Card className="mt-3">
          {call.transcript.length === 0 ? (
            <p className="text-sm text-muted">
              {call.active ? 'Waiting for the conversation to start…' : 'No transcript available.'}
            </p>
          ) : (
            <ol className="flex flex-col gap-3">
              {call.transcript.map((line) => (
                <li
                  key={`${line.at}-${line.role}-${line.text.slice(0, 40)}`}
                  className="text-sm leading-6"
                >
                  <span className="font-medium text-strong">
                    {line.role === 'assistant'
                      ? 'Assistant'
                      : line.role === 'caller'
                        ? 'Them'
                        : '·'}
                  </span>{' '}
                  <span className={line.role === 'system' ? 'text-muted' : 'text-strong'}>
                    {line.text}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>

      {call.checkins.length > 0 ? (
        <section className="mt-8">
          <SectionHeading title="Questions for you" count={call.checkins.length} />
          <Card className="mt-3">
            <ul className="flex flex-col gap-3 text-sm leading-6">
              {call.checkins.map((checkin) => (
                <li key={checkin.id}>
                  <p className="text-strong">“{checkin.question}”</p>
                  <p className="text-muted">
                    {checkin.answer
                      ? `You answered: ${checkin.answer}`
                      : checkin.deliveryStatus === 'superseded'
                        ? 'Replaced by a newer question.'
                        : checkin.deliveryStatus === 'failed'
                          ? 'The notice could not be delivered.'
                          : checkin.expiresAt && Date.parse(checkin.expiresAt) <= Date.now()
                            ? 'This question expired without an answer.'
                            : checkin.deliveryStatus === 'delivered' && call.active
                              ? 'Waiting for your answer.'
                              : 'No answer given.'}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      <section className="mt-8 mb-10">
        <SectionHeading title="The brief you approved" />
        <Card className="mt-3">
          <dl className="grid gap-3 text-sm leading-6">
            {[
              ['May share', call.brief.context],
              ['May agree to', call.brief.mayAgreeTo],
              ['Must not', call.brief.mustNot],
              ['Language', call.brief.language],
              [
                'Voicemail',
                call.brief.onVoicemail === 'leave_message' ? 'Leave a message' : 'Hang up',
              ],
              ['Time limit', `${call.maxMinutes} minutes`],
            ]
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="font-medium text-muted">{label}</dt>
                  <dd className="text-strong">{value}</dd>
                </div>
              ))}
          </dl>
        </Card>
      </section>
    </PageShell>
  );
}
