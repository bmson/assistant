import { getOwnerFactsView, type MemorySnapshot } from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  FirestoreProfilePeopleReadRepository,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { recompileCard } from '@/app/profile/actions';
import { AddFact } from '@/app/profile/add-fact';
import { FactRow, type FactView } from '@/app/profile/fact-row';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { savedNoteCreatedLabel, savedNoteValidityLabel } from '@/lib/saved-note-date-display';
import { getDb, getFirestoreInstallationStore } from '@/lib/server';
import {
  Badge,
  cardShellClass,
  countBadgeClass,
  EmptyState,
  MetaLine,
  microLabelClass,
  PageHeader,
  PageShell,
  Panel,
  SectionHeading,
  summaryClass,
} from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';

export const metadata = { title: 'About you' };
export const dynamic = 'force-dynamic';

const DOMAIN_ORDER = [
  'identity',
  'work',
  'home',
  'relationships',
  'preferences',
  'health',
  'other',
] as const;

function toFactView(m: MemorySnapshot, now: Date, inCard: boolean): FactView {
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
    inCard,
    aboutOwner: true,
    originTrust: m.originTrust,
    sourceTaskId: m.sourceTaskId,
    createdLabel: savedNoteCreatedLabel(m.createdAt, now),
    validityLabel: savedNoteValidityLabel(m.validFrom, m.validUntil),
  };
}

/**
 * The configured owner's facts, read only while that owner is the sole agent
 * and no privacy erasure starts or runs during the read.
 */
async function readFirestoreOwnerFacts() {
  const config = loadConfig();
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const store = getFirestoreInstallationStore();
  const agentId = config.FIRESTORE_AGENT_ID;
  const assertConfiguredOwner = async () => {
    const agents = await store.collection('agents').limit(2).get();
    if (
      agents.size !== 1 ||
      agents.docs[0]?.id !== store.doc('agents', agentId).id ||
      agents.docs[0]?.get('id') !== agentId
    )
      throw new Error('About page requires one matching configured owner');
  };
  await assertConfiguredOwner();
  const fence = await readPrivacyErasureFence(store, agentId);
  const view = await getOwnerFactsView(new FirestoreProfilePeopleReadRepository(store, agentId));
  await assertConfiguredOwner();
  await assertPrivacyErasureFenceUnchanged(store, agentId, fence);
  return view;
}

export default async function AboutYouPage() {
  await requireOwner();
  const config = loadConfig();
  const firestore = config.PERSISTENCE_DRIVER === 'firestore';
  const now = new Date();
  const { owner, ownerFacts, card, cardFactIds } = firestore
    ? await readFirestoreOwnerFacts()
    : await getOwnerFactsView(getDb());
  const inCard = new Set(cardFactIds);
  const byDomain = DOMAIN_ORDER.map((domain) => ({
    domain,
    facts: ownerFacts.filter((m) => (m.domain ?? 'other') === domain),
  })).filter((group) => group.facts.length > 0);
  const pinnedCount = ownerFacts.filter((m) => m.pinned).length;

  return (
    <PageShell size="reading">
      <PageHeader
        // /profile is PostgreSQL-only; Firestore's portable hub is /profile/memories.
        back={{ href: firestore ? '/profile/memories' : '/profile', label: 'Memory' }}
        title={`About ${owner?.name ?? 'you'}`}
        intro="Everything the assistant has learned about you, and the compact summary it carries into every conversation."
      />

      {/* The compiled card first: it is what the assistant actually sees. */}
      <Panel className="mt-6">
        <details open>
          <summary className={summaryClass}>
            Used in conversations
            <span className={countBadgeClass}>{pinnedCount} pinned</span>
            <span className="text-xs font-normal text-muted">
              {card ? `refreshed ${relativeTime(card.compiledAt, now)}` : 'not prepared yet'}
            </span>
          </summary>
          {card?.content ? (
            <div className="mt-4 max-h-52 overscroll-contain overflow-y-auto rounded-xl bg-sunken/60 p-4 text-sm leading-6 whitespace-pre-wrap text-strong">
              {card.content}
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              Nothing is selected yet. Pin a fact below or refresh this summary after adding one.
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <form action={recompileCard}>
              <SubmitButton variant="outline" pendingLabel="Refreshing…">
                Refresh summary
              </SubmitButton>
            </form>
            <span className="text-xs text-muted">
              This compact context is what the assistant sees before it searches deeper memory.
            </span>
          </div>
        </details>
      </Panel>

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionHeading title="Your facts" count={ownerFacts.length} />
          {owner ? <AddFact subjectContactId={owner.id} subjectLabel="you" /> : null}
        </div>
        {byDomain.length === 0 ? (
          <EmptyState>
            No details yet — they are added from conversations only after review.
          </EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {byDomain.map((group) => {
              const pinnedInDomain = group.facts.filter((m) => m.pinned).length;
              return (
                <details key={group.domain} className="rounded-xl bg-sunken/55 p-3.5">
                  <summary className={summaryClass}>
                    <span className={`${microLabelClass} text-muted`}>{group.domain}</span>
                    <span className={countBadgeClass}>{group.facts.length}</span>
                    {pinnedInDomain > 0 ? (
                      <span className="text-xs font-medium text-accent">
                        {pinnedInDomain} pinned
                      </span>
                    ) : null}
                  </summary>
                  <div className="mt-3 flex flex-col gap-2">
                    {group.facts.map((m) => (
                      <FactRow key={m.id} fact={toFactView(m, now, inCard.has(m.id))} />
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
    </PageShell>
  );
}
