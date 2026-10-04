import { AUDIT_SECTIONS, type AuditSection } from '@assistant/application/audit-investigation';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOwner } from '@/auth';
import { getAuditInvestigation } from '@/lib/audit-investigation';
import { formatUsd } from '@/lib/format';
import {
  btn,
  focusRing,
  MetaLine,
  PageHeader,
  PageShell,
  SectionHeading,
  selectClass,
  summaryClass,
} from '@/lib/ui';
import { StatusChip } from '@/lib/views';
import { InvestigationBrief } from './investigation-brief';

export const metadata = { title: 'Audit investigation' };
export const dynamic = 'force-dynamic';
const labels: Record<AuditSection, string> = {
  toolCalls: 'Tool actions',
  modelCalls: 'Model calls',
  modelCallAudit: 'Model context and answers',
  approvals: 'Approvals',
  messages: 'Task messages',
  contextMessages: 'Conversation at task start',
  responseChecks: 'Response quality checks',
  recallMetrics: 'Recall diagnostics',
};
const payloadFields = new Set([
  'args',
  'result',
  'error',
  'decision',
  'payload',
  'resolutionPayload',
  'systemPrompt',
  'input',
  'output',
  'text',
]);
function fieldLabel(key: string) {
  const names: Record<string, string> = {
    args: 'Arguments',
    result: 'Result',
    error: 'Error',
    decision: 'Policy decision',
    payload: 'Approval request',
    resolutionPayload: 'Approval response',
    systemPrompt: 'System instructions',
    input: 'Model input',
    output: 'Model output',
    text: 'Message',
  };
  return (
    names[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())
  );
}
export default async function AuditDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    section?: string;
    cursor?: string;
    entry?: string;
    field?: string;
    offset?: string;
  }>;
}) {
  await requireOwner();
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const query = await searchParams;
  if (query.section && !AUDIT_SECTIONS.includes(query.section as AuditSection)) notFound();
  const section = query.section ? (query.section as AuditSection) : undefined;
  let report: Awaited<ReturnType<typeof getAuditInvestigation>>;
  try {
    report = await getAuditInvestigation(id, {
      section,
      cursor: query.cursor,
      entryId: query.entry,
      field: query.field,
      offset: query.offset ? Number(query.offset) : undefined,
      limit: 10,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ')) notFound();
    throw error;
  }
  if (!report) notFound();
  const task = report.task as Record<string, unknown>;
  return (
    <PageShell size="reading" className="grid gap-6">
      <PageHeader
        back={{ href: '/audit', label: 'Audit trail' }}
        title={String(task.title || task.type)}
        intro="Follow the request, decisions, evidence, and response to understand what happened."
      />
      <section
        aria-label="Task summary"
        className="grid min-w-0 gap-3 border-y border-edge/70 py-5"
      >
        <div className="flex flex-wrap items-center gap-3">
          <StatusChip status={String(task.status)} />
          <MetaLine
            segments={[
              `Attempt ${String(task.attempt)}`,
              `${formatUsd(String(task.spentUsd ?? 0))} spent`,
            ]}
          />
        </div>
        <p className="text-sm leading-6 whitespace-pre-wrap break-words">
          {String(task.progress || 'No progress recorded.')}
        </p>
        <p className="text-xs leading-5 text-muted">
          Record ID <code className="break-all select-all">{id}</code>
        </p>
      </section>
      <form
        action={`/audit/${id}`}
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-3 sm:max-w-lg"
      >
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">
          Evidence section
          <select name="section" defaultValue={section ?? ''} className={`w-full ${selectClass}`}>
            <option value="">Overview</option>
            {AUDIT_SECTIONS.map((name) => (
              <option key={name} value={name}>
                {labels[name]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={btn.outline}>
          View
        </button>
      </form>
      {report.sections.map((group) => (
        <section key={group.name} className="grid gap-3" aria-label={labels[group.name]}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionHeading title={labels[group.name]} count={group.entries.length} />
            <a
              className={btn.outline}
              href={`/api/audit/${id}?${new URLSearchParams({ section: group.name, ...(query.cursor && section === group.name ? { cursor: query.cursor } : {}), ...(query.entry && section === group.name ? { entry: query.entry } : {}), ...(query.field && section === group.name ? { field: query.field, offset: query.offset ?? '0' } : {}) }).toString()}`}
              download
            >
              Download records
            </a>
          </div>
          {group.entries.length === 0 ? (
            <p className="text-sm text-muted">
              No records available in this view. Older tasks may have missing or expired capture.
            </p>
          ) : null}
          {group.entries.map((entry) => {
            const titleField = ['toolName', 'model', 'role'].find(
              (name) => entry.fields[name]?.text && entry.fields[name].text !== 'null',
            );
            const metadata = Object.entries(entry.fields).filter(
              ([key, field]) =>
                !payloadFields.has(key) &&
                !['id', 'createdAt', 'requestedAt', titleField].includes(key) &&
                field.text &&
                field.text !== 'null',
            );
            return (
              <article
                key={entry.id}
                className="grid min-w-0 gap-4 rounded-[var(--radius-card)] bg-raised p-4 ring-1 ring-edge/70 sm:p-5"
              >
                <div className="grid min-w-0 gap-1">
                  <h3 className="text-sm font-semibold break-words">
                    {titleField ? entry.fields[titleField].text : labels[group.name]}
                  </h3>
                  <MetaLine
                    segments={[
                      <time key="time" dateTime={entry.at ?? undefined}>
                        {entry.at
                          ? entry.at.replace('T', ' ').replace(/Z$/, ' UTC')
                          : 'Time not recorded'}
                      </time>,
                    ]}
                  />
                </div>
                {metadata.length ? (
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm min-[400px]:grid-cols-2 sm:grid-cols-3">
                    {metadata.map(([key, field]) => (
                      <div key={key} className="min-w-0">
                        <dt className="text-xs leading-5 text-muted">{fieldLabel(key)}</dt>
                        <dd className="leading-6 break-words [overflow-wrap:anywhere]">
                          {field.text}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {Object.entries(entry.fields)
                  .filter(
                    ([key, field]) => payloadFields.has(key) && field.text && field.text !== 'null',
                  )
                  .map(([key, field]) => (
                    <details
                      key={key}
                      className="min-w-0 border-t border-edge/70 pt-1"
                      open={query.field === key || ['error', 'text', 'output'].includes(key)}
                    >
                      <summary className={summaryClass}>
                        {fieldLabel(key)}
                        {field.hasMore ? ' · more available' : ''}
                      </summary>
                      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-sunken p-3 text-xs leading-5">
                        {field.text || 'Not recorded'}
                      </pre>
                      {field.hasMore ? (
                        <Link
                          className={`rounded-md text-sm underline ${focusRing}`}
                          prefetch={false}
                          href={`/audit/${id}?section=${group.name}&entry=${entry.id}&field=${encodeURIComponent(key)}&offset=${field.offset + field.text.length}`}
                        >
                          Continue this field ({field.offset + field.text.length} of{' '}
                          {field.totalChars} characters)
                        </Link>
                      ) : null}
                    </details>
                  ))}
                <details className="min-w-0 border-t border-edge/70 pt-1">
                  <summary className={summaryClass}>Record identifier</summary>
                  <code className="block pb-2 text-xs leading-5 text-muted break-all select-all">
                    {entry.id}
                  </code>
                </details>
              </article>
            );
          })}
          {group.nextCursor ? (
            <Link
              className={btn.outline}
              prefetch={false}
              href={`/audit/${id}?section=${group.name}&cursor=${encodeURIComponent(group.nextCursor)}`}
            >
              Older {labels[group.name].toLowerCase()}
            </Link>
          ) : null}
        </section>
      ))}
      <details className="rounded-xl bg-sunken p-4 text-sm">
        <summary className={summaryClass}>Evidence coverage and limitations</summary>
        <ul className="mt-2 grid list-disc gap-2 pl-5">
          {report.evidenceNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </details>
      <details className="rounded-xl border border-edge p-4">
        <summary className={summaryClass}>Investigate with the assistant</summary>
        <div className="mt-4">
          <InvestigationBrief prompt={report.investigationPrompt} />
        </div>
      </details>
      <details className="rounded-xl border border-edge p-4">
        <summary className={summaryClass}>Task setup and diagnostics</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">
          {JSON.stringify(report.task, null, 2)}
        </pre>
      </details>
    </PageShell>
  );
}
