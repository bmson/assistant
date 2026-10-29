import { getMemoryHubOverview } from '@assistant/application/profile';
import { loadConfig } from '@assistant/config';
import { createInstallationStore, FirestoreProfileMemoryHubRepository } from '@assistant/firestore';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MemoryNavigation } from '@/app/profile/memory-navigation';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { ownerEditorAvailability } from '@/lib/owner-editor-availability';
import { cardShellClass, PageHeader, PageShell, SectionHeading } from '@/lib/ui';

export const metadata = { title: 'Memory' };
export const dynamic = 'force-dynamic';

type Overview = Awaited<ReturnType<typeof getMemoryHubOverview>>;

function ReadOnlyMemoryHub({
  overview,
  now,
  sessionRefreshMessage,
}: {
  overview: Overview;
  now: Date;
  sessionRefreshMessage: string | null;
}) {
  const { owner, memoryHealth, recallFeedback, quarantined, latestOrganizer, card } = overview;
  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="What I remember"
        intro={`See what shapes the assistant’s understanding of ${owner?.name ?? 'you'} and what still needs review.`}
      />
      <MemoryNavigation />
      {sessionRefreshMessage ? (
        <p role="status" className="mt-4 text-sm text-muted">
          {sessionRefreshMessage}
        </p>
      ) : null}

      <section className="mt-8">
        <SectionHeading title="Memory health" />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className={`${cardShellClass} p-4 sm:p-5`}>
            <p className="font-display text-3xl font-semibold tracking-[-0.04em]">
              {memoryHealth.totalUsable.toLocaleString()}
            </p>
            <p className="mt-2 text-sm font-semibold">In use by the assistant</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Active facts available for recall. {memoryHealth.ownerConfirmed.toLocaleString()}{' '}
              verified by you.
            </p>
          </div>
          <div className={`${cardShellClass} p-4 sm:p-5`}>
            <p className="font-display text-3xl font-semibold tracking-[-0.04em]">
              {memoryHealth.awaitingReview.toLocaleString()}
            </p>
            <p className="mt-2 text-sm font-semibold">Awaiting your review</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Held back from recall until their source is reviewed.
            </p>
          </div>
          <div className={`${cardShellClass} p-4 sm:p-5`}>
            <p className="font-display text-3xl font-semibold tracking-[-0.04em]">
              {memoryHealth.notYetOrganized.toLocaleString()}
            </p>
            <p className="mt-2 text-sm font-semibold">Not yet organized</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {memoryHealth.lastOrganizedAt
                ? `Last organized ${relativeTime(memoryHealth.lastOrganizedAt, now)}.`
                : 'No completed organization yet.'}
            </p>
          </div>
          <div className={`${cardShellClass} p-4 sm:p-5`}>
            <p className="font-display text-3xl font-semibold tracking-[-0.04em]">
              {recallFeedback.rated > 0 ? `${recallFeedback.helpful}/${recallFeedback.rated}` : '—'}
            </p>
            <p className="mt-2 text-sm font-semibold">Recall you rated useful</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              In the last {recallFeedback.windowDays} days
              {recallFeedback.lastRatedAt
                ? `; last rated ${relativeTime(recallFeedback.lastRatedAt, now)}`
                : ''}
              .
            </p>
          </div>
        </div>
      </section>

      {quarantined.length > 0 ? (
        <section className="mt-8">
          <SectionHeading title="Waiting for review" />
          <p className="mt-2 text-xs leading-5 text-muted">
            These facts remain out of conversations until their sources are approved.
          </p>
          <ul className="mt-3 space-y-2">
            {quarantined.slice(0, 3).map((fact) => (
              <li key={fact.id} className={`${cardShellClass} p-4 text-sm leading-6`}>
                <p className="break-words">{fact.content}</p>
                <p className="mt-2 text-xs text-muted">Saved {relativeTime(fact.createdAt, now)}</p>
              </li>
            ))}
          </ul>
          {memoryHealth.awaitingReview > 3 ? (
            <p className="mt-2 text-xs text-muted">
              {memoryHealth.awaitingReview - 3} more awaiting review.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="mt-8">
        <SectionHeading title="Overview" />
        <div className={`${cardShellClass} mt-3 grid gap-3 p-4 text-sm sm:grid-cols-2 sm:p-5`}>
          <p>
            {overview.ownerFactCount.toLocaleString()}{' '}
            {overview.ownerFactCount === 1 ? 'fact' : 'facts'} about you
          </p>
          <p>
            {overview.peopleCount.toLocaleString()}{' '}
            {overview.peopleCount === 1 ? 'person' : 'people'}
          </p>
          <p>
            {card
              ? `Profile summary refreshed ${relativeTime(card.compiledAt, now)}`
              : 'No profile summary yet'}
          </p>
          <p>{latestOrganizer ? `Organizer: ${latestOrganizer.status}` : 'No organizer run yet'}</p>
        </div>
        <Link
          href="/profile/about"
          className="mt-3 inline-flex text-sm font-medium text-accent underline underline-offset-2"
        >
          View what I know about you
        </Link>
      </section>
    </PageShell>
  );
}

/** PostgreSQL keeps its legacy deep link; Firestore exposes only this read-only hub. */
export default async function MemoryHubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') {
    const current = await searchParams;
    const next = new URLSearchParams({ view: 'library' });
    for (const [key, value] of Object.entries(current)) {
      if (value) next.set(key, value);
    }
    redirect(`/profile/knowledge?${next.toString()}`);
  }

  const session = await requireOwner();
  const editorAvailability = ownerEditorAvailability({
    formSessionScope: session.formSessionScope,
    editorAvailable: false,
    currentPath: '/profile/memories',
  });
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  try {
    const overview = await getMemoryHubOverview(
      new FirestoreProfileMemoryHubRepository(store, config.FIRESTORE_AGENT_ID),
    );
    return (
      <ReadOnlyMemoryHub
        overview={overview}
        now={new Date()}
        sessionRefreshMessage={
          editorAvailability.kind === 'sign_in_again' ? editorAvailability.message : null
        }
      />
    );
  } finally {
    await store.db.terminate();
  }
}
