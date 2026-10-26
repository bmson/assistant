import { getPersonDossier, type PersonDossier } from '@assistant/application/people';
import {
  eventDateLabel,
  lastContactLabel,
  PERSON_GROUP_LABELS,
} from '@assistant/application/people-presentation';
import type { MemorySnapshot } from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertFirestoreInstallationOwner,
  assertPrivacyErasureFenceUnchanged,
  createInstallationStore,
  firestoreOwnerEditorViewSnapshot,
  readFirestoreOwnerEditorIssuanceContext,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { Handshake, MapPin, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  OwnerEditorControls,
  type OwnerEditorControlsProps,
} from '@/app/people/owner-editor-controls';
import { PersonAvatar } from '@/app/people/person-avatar';
import { ConnectionList, RelationshipList } from '@/app/people/relationship-list';
import { BrowseFact } from '@/app/profile/browse-fact';
import type { FactView } from '@/app/profile/fact-row';
import { requireOwner } from '@/auth';
import { getFirestorePersonDossier } from '@/lib/firestore-people';
import { relativeTime } from '@/lib/format';
import { buildOwnerEditorView } from '@/lib/owner-editor-view';
import { readPostgresOwnerEditorViewInputs, withPostgresMemoryBrowseRead } from '@/lib/server';
import {
  Badge,
  EmptyState,
  InfoGrid,
  InfoItem,
  MetaLine,
  PageHeader,
  PageShell,
  Panel,
  SectionHeading,
} from '@/lib/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Person' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FACT_LIMIT = 250;

function toFactView(memory: MemorySnapshot, now: Date, subjectLabel: string): FactView {
  const from = memory.validFrom?.toISOString().slice(0, 10);
  const until = memory.validUntil?.toISOString().slice(0, 10);
  return {
    id: memory.id,
    content: memory.content,
    kind: memory.kind,
    domain: memory.domain ?? '',
    confidence: Number(memory.confidence),
    importance: memory.importance,
    ownerConfirmed: memory.ownerConfirmed,
    pinned: memory.pinned,
    organized: memory.lastConsolidatedAt !== null,
    inCard: false,
    aboutOwner: false,
    originTrust: memory.originTrust,
    sourceTaskId: memory.sourceTaskId,
    subjectLabel,
    createdLabel: relativeTime(memory.createdAt, now),
    validityLabel: from ? `${from}–${until ?? 'now'}` : '',
  };
}

/** "birthday" / "anniversary" / the owner's own word for a custom occasion. */
function occasionNoun(kind: string, label: string): string {
  if (kind === 'custom') return label || 'occasion';
  return kind;
}

async function loadPersonDossier(
  id: string,
  now: Date,
  formSessionScope: string | undefined,
): Promise<{
  data: PersonDossier | null;
  editor: OwnerEditorControlsProps | null;
}> {
  const config = loadConfig();
  const enabled =
    !config.ASSISTANT_RELEASE_WRITES_PAUSED &&
    !config.RESTORE_REHEARSAL &&
    !(config.PERSISTENCE_DRIVER !== 'firestore' && config.POSTGRES_SOURCE_WRITES_FENCED);
  const editorInput = (data: PersonDossier) => ({
    contactId: id,
    relationIds: [
      ...new Set(
        data.relations
          .map((relation) => relation.id)
          .filter((relationId) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              relationId,
            ),
          ),
      ),
    ],
  });
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    return withPostgresMemoryBrowseRead(async (db) => {
      const data = await getPersonDossier(db, id, {
        factLimit: FACT_LIMIT,
        now,
        includeEditingSuggestions: false,
      });
      let editor: OwnerEditorControlsProps | null = null;
      if (data && enabled && formSessionScope && config.AUTH_SECRET) {
        try {
          const inputs = await readPostgresOwnerEditorViewInputs(db, editorInput(data));
          if (inputs)
            editor = buildOwnerEditorView({
              ...inputs,
              enabled,
              formSessionScope,
              secret: config.AUTH_SECRET,
              displayedContact: data.profile.contact,
              displayedRelationships: data.relations,
            });
        } catch {
          /* Bounded editor read failure does not erase a valid dossier. */
        }
      }
      return { data, editor };
    });
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  try {
    await assertFirestoreInstallationOwner(store, config.FIRESTORE_AGENT_ID);
    const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
    const data = await getFirestorePersonDossier(store, config.FIRESTORE_AGENT_ID, id, {
      factLimit: FACT_LIMIT,
      now,
      includeEditingSuggestions: false,
    });
    let editor: OwnerEditorControlsProps | null = null;
    if (data && enabled && formSessionScope && config.AUTH_SECRET) {
      try {
        const context = await readFirestoreOwnerEditorIssuanceContext(
          store,
          config.FIRESTORE_AGENT_ID,
        );
        if (context) {
          const snapshot = await firestoreOwnerEditorViewSnapshot(
            store,
            config.FIRESTORE_AGENT_ID,
            editorInput(data),
          );
          editor = buildOwnerEditorView({
            enabled,
            context,
            snapshot,
            formSessionScope,
            secret: config.AUTH_SECRET,
            displayedContact: data.profile.contact,
            displayedRelationships: data.relations,
          });
        }
      } catch {
        /* Unsupported/malformed/capped editor snapshot stays read-only. */
      }
    }
    await assertFirestoreInstallationOwner(store, config.FIRESTORE_AGENT_ID);
    await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
    return { data, editor };
  } finally {
    await store.db.terminate();
  }
}

export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ q?: string }>;
}) {
  const session = await requireOwner();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const rawQuery = (await searchParams)?.q;
  const query = (typeof rawQuery === 'string' ? rawQuery : '').trim().slice(0, 120);
  const backHref = `/people${query ? `?q=${encodeURIComponent(query)}` : ''}`;
  const now = new Date();
  let dossier: PersonDossier | null;
  let editor: OwnerEditorControlsProps | null = null;
  try {
    const loaded = await loadPersonDossier(id, now, session.formSessionScope);
    dossier = loaded.data;
    editor = loaded.editor;
  } catch {
    return (
      <PageShell size="reading">
        <PageHeader back={{ href: backHref, label: 'People' }} title="Person unavailable" />
        <p role="alert" className="mt-4 text-muted">
          Could not load this view. Your search is preserved.
        </p>
        <Link
          href={`/people/${id}${query ? `?q=${encodeURIComponent(query)}` : ''}`}
          className="mt-4 inline-block underline"
        >
          Try again
        </Link>
      </PageShell>
    );
  }
  if (!dossier) notFound();

  const { profile, location, origins, relations, connections, events } = dossier;
  const { contact, facts, totalFacts, occasions } = profile;
  const lastContact = lastContactLabel(dossier.lastContactAt, now);
  const groupLabel = dossier.group === 'other' ? null : PERSON_GROUP_LABELS[dossier.group];

  return (
    <PageShell size="reading">
      <PageHeader back={{ href: backHref, label: 'People' }} title={contact.name} />

      {/* The identity line: who they are to you, where they are, when you last
          spoke. Every segment is dropped when its source is empty, so this
          never renders a dangling separator or an empty claim. */}
      <div className="mt-4 flex min-w-0 items-start gap-4">
        <PersonAvatar name={contact.name} size="lg" />
        <div className="min-w-0 flex-1">
          <MetaLine
            segments={[
              contact.relationship
                ? `Relationship to you: ${contact.relationship}`
                : 'Relationship to you: not recorded',
              location ? (
                <>
                  <MapPin className="size-3.5" aria-hidden="true" />
                  {location}
                </>
              ) : null,
              lastContact,
            ]}
            className="text-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {groupLabel ? <Badge tone="muted">{groupLabel}</Badge> : null}
            {contact.trust === 'unknown' ? (
              <Badge
                tone="amber"
                size="xs"
                title="Content from this person is treated as untrusted."
              >
                Unverified
              </Badge>
            ) : null}
          </div>
        </div>
      </div>

      {editor ? (
        <section className="mt-4" aria-label="Edit people and family">
          <OwnerEditorControls {...editor} />
        </section>
      ) : null}
      {contact.aliases.length ? (
        <p className="mt-3 break-words text-sm text-muted">
          Also known as {contact.aliases.join(', ')}
        </p>
      ) : null}
      {origins.length > 0 ? (
        <Panel className="mt-6">
          <InfoGrid columns={1}>
            <InfoItem label="How you met">
              <span className="flex items-start gap-2">
                <Handshake className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                <span>
                  {origins.map((origin) => (
                    <span key={origin.id} className="block">
                      {origin.sentence}
                    </span>
                  ))}
                </span>
              </span>
            </InfoItem>
          </InfoGrid>
        </Panel>
      ) : null}

      {occasions.length ? (
        <section id="important-dates" className="mt-6">
          <SectionHeading title="Saved dates" />
          <ul className="mt-3 space-y-2">
            {occasions.map((occasion) => (
              <li key={occasion.id} className="rounded-xl bg-raised p-3 text-sm">
                <span className="font-medium">{occasion.label || occasion.kind}</span> ·{' '}
                {occasion.month}/{occasion.day}
                {occasion.year ? `/${occasion.year}` : ''}
                {occasion.quarantined ? ' · Unreviewed' : ''}
                {occasion.notes ? <p className="mt-1 text-muted">{occasion.notes}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {dossier.entityId ? (
        <p className="mt-6">
          <Link
            className="text-sm text-accent underline"
            href={`/profile/knowledge?view=map&entity=${encodeURIComponent(dossier.entityId)}`}
          >
            Browse this person’s connections
          </Link>
        </p>
      ) : null}

      {/* Relationships to other people — the section this page exists for, so
          it is on the page rather than behind a disclosure, and adding one
          happens here instead of sending the owner to the knowledge graph to
          look this person up again. */}
      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionHeading title="Connections between people" count={relations.length} />
        </div>
        {relations.length === 0 ? (
          <EmptyState>
            No connections to other people are recorded yet. They are picked up from what you tell
            the assistant.
          </EmptyState>
        ) : (
          <RelationshipList relations={relations} now={now} peopleQuery={query} />
        )}
      </section>

      {/* Everything else the graph knows: employers, places, events. */}
      {connections.length > 0 ? (
        <section className="mt-8">
          <SectionHeading title="Also connected" count={connections.length} />
          <ConnectionList connections={connections} now={now} />
        </section>
      ) : null}

      {/* What happened, most recent first. */}
      <section className="mt-8">
        <SectionHeading title="Recently" count={events.length} />
        {events.length === 0 ? (
          <EmptyState>
            Nothing has been recorded about time spent with {contact.name}. Mention it in a
            conversation and the assistant will note it here.
          </EmptyState>
        ) : (
          <>
            <ol className="mt-3 flex flex-col gap-2">
              {events.map((event) => (
                <li
                  key={event.id}
                  className="flex min-w-0 gap-3 rounded-xl bg-raised p-3.5 ring-1 ring-edge/60"
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent"
                  >
                    <Sparkles className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm leading-6 text-pretty text-strong">{event.content}</p>
                    <MetaLine
                      segments={[
                        eventDateLabel(event.occurredAt, now),
                        // A row dated only by when the assistant wrote it must
                        // not be read as the date the thing happened.
                        event.dateIsRecordTime ? 'as recorded' : null,
                        event.originTrust === 'owner' ? null : `from ${event.originTrust}`,
                      ]}
                    />
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-muted">
              What happened is kept for 90 days; lasting details are saved as facts below.
            </p>
          </>
        )}
      </section>

      {/* A reminder strip, but only ever backed by a real occasion inside its
          own lead window — the same one that reaches the morning brief. */}
      {dossier.upcomingOccasion ? (
        <section className="mt-6 rounded-2xl border border-accent/25 bg-accent/[0.06] p-4">
          <p className="text-sm font-semibold text-strong">
            {contact.name.split(' ')[0]}’s{' '}
            {occasionNoun(dossier.upcomingOccasion.kind, dossier.upcomingOccasion.label)}{' '}
            {dossier.upcomingOccasion.daysUntil === 0
              ? 'is today'
              : dossier.upcomingOccasion.daysUntil === 1
                ? 'is tomorrow'
                : `is in ${dossier.upcomingOccasion.daysUntil} days`}
          </p>
          <p className="mt-0.5 text-xs text-muted">Saved upcoming occasion.</p>
        </section>
      ) : null}

      {/* Saved facts: durable knowledge, as distinct from what happened. */}
      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionHeading title="Saved facts" count={totalFacts} />
        </div>
        {totalFacts > FACT_LIMIT ? (
          <p className="mt-1 text-xs text-muted">
            Showing the {FACT_LIMIT} most relevant facts to keep this page quick to open.
          </p>
        ) : null}
        {facts.length === 0 ? (
          <EmptyState>No facts are saved about {contact.name} yet.</EmptyState>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {facts.map((fact) => (
              <BrowseFact key={fact.id} fact={toFactView(fact, now, contact.name)} />
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
