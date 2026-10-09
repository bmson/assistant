import { randomUUID } from 'node:crypto';
import {
  type ClosedCommitmentView,
  type CommitmentView,
  listCommitmentOverview,
} from '@assistant/application/commitments';
import {
  type EmailObligationView,
  listOwnerEmailObligations,
} from '@assistant/application/email-obligations';
import { getMemoryHubOverview, type MemorySnapshot } from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreProfileMemoryHubRepository,
  getFirestoreClosedCommitmentOverview,
  getFirestoreCommitmentOverview,
} from '@assistant/firestore';
import {
  ArrowRight,
  CheckCircle2,
  Library,
  type LucideIcon,
  Mic,
  Network,
  ShieldCheck,
  ShieldQuestion,
  ThumbsUp,
  UserRound,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { AutoRefresh } from '@/app/auto-refresh';
import { CommitmentsPanel } from '@/app/profile/commitments-panel';
import { EmailObligationsPanel } from '@/app/profile/email-obligations-panel';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { MemoryOrganizer } from '@/app/profile/memory-organizer';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import {
  getApplication,
  getDb,
  getEmailObligationRepository,
  getFirestoreInstallationStore,
} from '@/lib/server';
import {
  CountBadge,
  cardInteractiveClass,
  cardShellClass,
  PageHeader,
  PageShell,
  SectionHeading,
} from '@/lib/ui';

export const metadata = { title: 'Memory' };

export const dynamic = 'force-dynamic';

/** The review inbox shows the head of the queue; the rest is one click away. */
const QUARANTINE_PREVIEW = 3;

/**
 * What the owner's own thumbs said about recall.
 *
 * The rating control has existed on every recalled reply for a while and
 * nothing ever read the results, so the owner was being asked a question whose
 * answer went nowhere. This reports the verdicts back as counts and no further:
 * the stored row deliberately holds no recalled text, so there is no honest way
 * to say *which* recall missed — only how often the owner said it did.
 */
function RecallFeedbackCard({
  feedback,
  now,
}: {
  feedback: {
    rated: number;
    helpful: number;
    notHelpful: number;
    lastRatedAt: Date | null;
    windowDays: number;
  };
  now: Date;
}) {
  const rated = feedback.rated;
  return (
    <div className={`${cardShellClass} p-4 sm:p-5`}>
      <div className="flex items-start justify-between gap-4">
        <span className="inline-flex size-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <ThumbsUp className="size-4" aria-hidden="true" />
        </span>
        <span className="font-display text-3xl font-semibold tracking-[-0.04em]">
          {rated > 0 ? `${feedback.helpful}/${rated}` : '—'}
        </span>
      </div>
      <p className="mt-4 text-sm font-semibold">Recall you rated</p>
      <p className="mt-1 text-xs leading-5 text-muted">
        {rated > 0 ? (
          <>
            {feedback.helpful === rated
              ? 'Every recalled reply you rated'
              : `${feedback.helpful} of ${rated} recalled replies you rated`}{' '}
            in the last {feedback.windowDays} days was useful
            {feedback.notHelpful > 0 ? `, and ${feedback.notHelpful} was not` : ''}.
            {feedback.lastRatedAt ? ` Last rated ${relativeTime(feedback.lastRatedAt, now)}.` : ''}
          </>
        ) : (
          <>
            Nothing rated in the last {feedback.windowDays} days. The thumbs on a reply that used
            recalled sources are how the assistant learns whether what it found was any use.
          </>
        )}
      </p>
    </div>
  );
}

function toFactView(m: MemorySnapshot, now: Date): FactView {
  const from = m.validFrom?.toISOString().slice(0, 10);
  const until = m.validUntil?.toISOString().slice(0, 10);
  return {
    id: m.id,
    content: m.content,
    kind: m.kind,
    domain: m.domain ?? '',
    confidence: Number(m.confidence),
    importance: m.importance,
    ownerConfirmed: m.ownerConfirmed,
    pinned: m.pinned,
    organized: m.lastConsolidatedAt !== null,
    inCard: false,
    aboutOwner: false,
    originTrust: m.originTrust,
    sourceTaskId: m.sourceTaskId,
    createdLabel: relativeTime(m.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
  };
}

/** The memory hub projection for the configured driver. */
async function readMemoryHub() {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') return getMemoryHubOverview(getDb());
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  return getMemoryHubOverview(
    new FirestoreProfileMemoryHubRepository(
      getFirestoreInstallationStore(),
      config.FIRESTORE_AGENT_ID,
    ),
  );
}

/** Open loops for the configured driver, in the shape the panel renders. */
async function readOpenCommitments(now: Date): Promise<CommitmentView[]> {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') return listCommitmentOverview(getDb());
  return getFirestoreCommitmentOverview(
    getFirestoreInstallationStore(),
    config.FIRESTORE_AGENT_ID,
    now,
  );
}

async function readClosedCommitments(): Promise<ClosedCommitmentView[]> {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') return getApplication().listClosedCommitments();
  return getFirestoreClosedCommitmentOverview(
    getFirestoreInstallationStore(),
    config.FIRESTORE_AGENT_ID,
  );
}

async function readEmailObligations(now: Date): Promise<EmailObligationView[]> {
  return listOwnerEmailObligations(getEmailObligationRepository(), now);
}

export default async function ProfilePage() {
  await requireOwner();
  const now = new Date();
  const {
    owner,
    quarantined,
    memoryHealth,
    recallFeedback,
    latestOrganizer,
    card,
    ownerFactCount,
    peopleCount,
  } = await readMemoryHub();
  const openCommitments = await readOpenCommitments(now);
  const closedCommitments = await readClosedCommitments();
  const emailObligations = await readEmailObligations(now);

  // Memory state only changes nightly or from an action on this page (which
  // revalidates on its own). The one thing that updates in the background is a
  // running consolidation pass — so poll only while one is active, instead of
  // re-running every query on this page every 8 seconds.
  const organizerActive =
    latestOrganizer?.status === 'pending' || latestOrganizer?.status === 'running';

  return (
    <PageShell size="reading">
      {organizerActive ? <AutoRefresh intervalMs={5_000} /> : null}
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="What I remember"
        intro={`See what shapes the assistant’s understanding of ${owner?.name ?? 'you'}, what still needs care, and what stays available for recall.`}
      />

      <CommitmentsPanel
        rows={openCommitments}
        closedRows={closedCommitments}
        reopenOperationIds={Object.fromEntries(
          closedCommitments.map((row) => [row.id, randomUUID()]),
        )}
      />
      <EmailObligationsPanel rows={emailObligations} />

      {/* Health first: the two numbers that say whether memory is in good order. */}
      <section className="mt-8">
        <SectionHeading title="Memory health" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Link
            href="/profile/knowledge?view=library"
            className={`${cardShellClass} ${cardInteractiveClass} group p-4 sm:p-5`}
          >
            <div className="flex items-start justify-between gap-4">
              <span className="inline-flex size-9 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Library className="size-4" aria-hidden="true" />
              </span>
              <span className="font-display text-3xl font-semibold tracking-[-0.04em]">
                {memoryHealth.totalUsable.toLocaleString()}
              </span>
            </div>
            <p className="mt-4 text-sm font-semibold">In use by the assistant</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Active facts that can be recalled in conversations
              {memoryHealth.ownerConfirmed > 0
                ? ` — ${memoryHealth.ownerConfirmed.toLocaleString()} verified by you`
                : ''}
              .
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent">
              Browse and manage
              <ArrowRight className="size-3" aria-hidden="true" />
            </span>
          </Link>

          <Link
            href="/profile/knowledge?view=library&state=review"
            className={`${cardInteractiveClass} group rounded-2xl p-4 ring-1 sm:p-5 ${
              memoryHealth.awaitingReview > 0
                ? 'bg-amber-50/70 ring-amber-200 dark:bg-amber-950/20 dark:ring-amber-900'
                : 'bg-raised ring-edge/70'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <span
                className={`inline-flex size-9 items-center justify-center rounded-xl ${
                  memoryHealth.awaitingReview > 0
                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                    : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                }`}
              >
                {memoryHealth.awaitingReview > 0 ? (
                  <ShieldQuestion className="size-4" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                )}
              </span>
              <span className="font-display text-3xl font-semibold tracking-[-0.04em]">
                {memoryHealth.awaitingReview.toLocaleString()}
              </span>
            </div>
            <p className="mt-4 text-sm font-semibold">
              {memoryHealth.awaitingReview > 0 ? 'Waiting on you' : 'Nothing to review'}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {memoryHealth.awaitingReview > 0
                ? 'Held back until you approve the source. Not used in conversations yet.'
                : 'Everything from unverified sources has been reviewed.'}
            </p>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent">
              {memoryHealth.awaitingReview > 0 ? 'Review now' : 'View'}
              <ArrowRight className="size-3" aria-hidden="true" />
            </span>
          </Link>
        </div>
        <div className="mt-3">
          <RecallFeedbackCard feedback={recallFeedback} now={now} />
        </div>
        <div className="mt-3">
          <MemoryOrganizer
            remaining={memoryHealth.notYetOrganized}
            latest={
              latestOrganizer
                ? {
                    id: latestOrganizer.id,
                    status: latestOrganizer.status,
                    progress: latestOrganizer.progress,
                    updatedLabel: relativeTime(latestOrganizer.updatedAt, now),
                  }
                : null
            }
          />
        </div>
      </section>

      {/* The review inbox — the only thing on this page that needs a decision.
          It shows the head of the queue rather than all hundred, so the hub
          stays a page you can take in at a glance. */}
      {quarantined.length > 0 ? (
        <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/65 p-5 dark:border-amber-900 dark:bg-amber-950/20">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShieldQuestion
              className="size-4 text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            />
            Awaiting your review
            {/* The health tile above counts every held memory; this list is
                capped at 100 by the query. Counting the capped array made the
                two disagree on the same page once the backlog passed the cap,
                and understated how much was actually waiting. */}
            <CountBadge tone="amber">{memoryHealth.awaitingReview}</CountBadge>
          </h2>
          <p className="mt-1 text-xs text-muted">
            These came from unverified sources. The assistant will not use them until you approve
            them.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {quarantined.slice(0, QUARANTINE_PREVIEW).map((m) => (
              <FactRow key={m.id} fact={toFactView(m, now)} quarantine />
            ))}
          </div>
          {memoryHealth.awaitingReview > QUARANTINE_PREVIEW ? (
            <Link
              href="/profile/knowledge?view=library&state=review"
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent"
            >
              Review all {memoryHealth.awaitingReview.toLocaleString()}
              <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
          ) : null}
        </section>
      ) : null}

      {/* Where the rest of it lives. Each tile carries a real number, so the
          hub says what is behind the door rather than only naming it. */}
      <section className="mt-8">
        <SectionHeading title="Explore" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <HubTile
            href="/people"
            icon={Users}
            title="People"
            detail={`${peopleCount} ${peopleCount === 1 ? 'person' : 'people'}`}
            hint="Birthdays, connections, and what you have done together."
          />
          <HubTile
            href="/profile/about"
            icon={UserRound}
            title={`About ${owner?.name ?? 'you'}`}
            detail={`${ownerFactCount} ${ownerFactCount === 1 ? 'fact' : 'facts'}`}
            hint={
              card
                ? `Chat summary refreshed ${relativeTime(card.compiledAt, now)}.`
                : 'The chat summary has not been prepared yet.'
            }
          />
          <HubTile
            href="/profile/knowledge?view=map"
            icon={Network}
            title="Knowledge graph"
            detail="Connections"
            hint="How everything the assistant knows fits together."
          />
          <HubTile
            href="/profile/voice"
            icon={Mic}
            title="Writing voice"
            hint="The voice the assistant imitates when it drafts for you."
          />
          <HubTile
            href="/profile/data"
            icon={ShieldCheck}
            title="Your data"
            hint="Export everything, or forget it permanently."
          />
        </div>
      </section>
    </PageShell>
  );
}

/** One route out of the hub, with a number when there is an honest one to show. */
function HubTile({
  href,
  icon: Icon,
  title,
  detail,
  hint,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  detail?: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className={`${cardShellClass} ${cardInteractiveClass} group flex min-w-0 items-start gap-3 p-4`}
    >
      <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-sunken text-muted">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold text-strong">{title}</span>
          {detail ? <span className="text-xs text-muted">{detail}</span> : null}
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted">{hint}</span>
      </span>
      <ArrowRight
        className="mt-1 size-3.5 shrink-0 text-muted motion-safe:transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  );
}
