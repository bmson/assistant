import { listPeopleDirectory, type PersonSummary } from '@assistant/application/people';
import {
  birthdayLabel,
  lastContactLabel,
  PERSON_GROUP_LABELS,
  PERSON_GROUPS,
  type PersonGroup,
} from '@assistant/application/people-presentation';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertFirestoreInstallationOwner,
  assertPrivacyErasureFenceUnchanged,
  createInstallationStore,
  readFirestoreOwnerEditorIssuanceContext,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { CalendarDays, MapPin, Search } from 'lucide-react';
import Link from 'next/link';
import {
  OwnerEditorControls,
  type OwnerEditorControlsProps,
} from '@/app/people/owner-editor-controls';
import { PersonAvatar } from '@/app/people/person-avatar';
import { MemoryNavigation } from '@/app/profile/memory-navigation';
import { requireOwner } from '@/auth';
import { listFirestorePeopleDirectory } from '@/lib/firestore-people';
import { ownerEditorAvailability } from '@/lib/owner-editor-availability';
import { buildOwnerEditorView } from '@/lib/owner-editor-view';
import { readPostgresOwnerEditorViewInputs, withPostgresMemoryBrowseRead } from '@/lib/server';
import {
  Badge,
  btn,
  EmptyState,
  inputClass,
  MetaLine,
  PageHeader,
  PageShell,
  SectionHeading,
} from '@/lib/ui';

export const metadata = { title: 'People' };
export const dynamic = 'force-dynamic';

/** Soonest-first, so an upcoming birthday is visible without opening anyone. */
const BIRTHDAY_HORIZON_DAYS = 30;

function matches(person: PersonSummary, query: string): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  return (
    person.name.toLocaleLowerCase().includes(needle) ||
    person.relationship.toLocaleLowerCase().includes(needle) ||
    (person.location?.toLocaleLowerCase().includes(needle) ?? false)
  );
}

async function loadPeopleDirectory(
  now: Date,
  formSessionScope: string | undefined,
): Promise<{
  data: PersonSummary[];
  editor: OwnerEditorControlsProps | null;
}> {
  const config = loadConfig();
  const enabled =
    !config.ASSISTANT_RELEASE_WRITES_PAUSED &&
    !config.RESTORE_REHEARSAL &&
    !(config.PERSISTENCE_DRIVER !== 'firestore' && config.POSTGRES_SOURCE_WRITES_FENCED);
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    return withPostgresMemoryBrowseRead(async (db) => {
      const data = await listPeopleDirectory(db, { now, browseOnly: true });
      let editor: OwnerEditorControlsProps | null = null;
      if (enabled && formSessionScope && config.AUTH_SECRET) {
        try {
          const inputs = await readPostgresOwnerEditorViewInputs(db, {});
          if (inputs)
            editor = buildOwnerEditorView({
              ...inputs,
              enabled,
              formSessionScope,
              secret: config.AUTH_SECRET,
            });
        } catch {
          /* Editor availability never substitutes an empty browse result. */
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
    const data = await listFirestorePeopleDirectory(store, config.FIRESTORE_AGENT_ID, now);
    let editor: OwnerEditorControlsProps | null = null;
    if (enabled && formSessionScope && config.AUTH_SECRET) {
      try {
        const context = await readFirestoreOwnerEditorIssuanceContext(
          store,
          config.FIRESTORE_AGENT_ID,
        );
        editor = buildOwnerEditorView({
          enabled,
          context,
          snapshot: { ownerId: config.FIRESTORE_AGENT_ID },
          formSessionScope,
          secret: config.AUTH_SECRET,
        });
      } catch {
        /* Keep the valid fenced directory usable when issuance is unavailable. */
      }
    }
    await assertFirestoreInstallationOwner(store, config.FIRESTORE_AGENT_ID);
    await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
    return { data, editor };
  } finally {
    await store.db.terminate();
  }
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireOwner();
  const { q } = await searchParams;
  const query = (typeof q === 'string' ? q : '').trim().slice(0, 120);
  const personHref = (id: string) =>
    `/people/${id}${query ? `?q=${encodeURIComponent(query)}` : ''}`;

  const now = new Date();
  let everyone: PersonSummary[];
  let editor: OwnerEditorControlsProps | null = null;
  try {
    const loaded = await loadPeopleDirectory(now, session.formSessionScope);
    everyone = loaded.data;
    editor = loaded.editor;
  } catch {
    return (
      <PageShell size="reading">
        <PageHeader back={{ href: '/profile', label: 'Memory' }} title="People" />
        <p role="alert" className="mt-4 text-muted">
          Could not load this view. Your search is preserved.
        </p>
        <Link
          href={`/people${query ? `?q=${encodeURIComponent(query)}` : ''}`}
          className={btn.outline}
        >
          Try again
        </Link>
      </PageShell>
    );
  }
  const people = everyone.filter((person) => matches(person, query));

  const byGroup = PERSON_GROUPS.map((group) => ({
    group,
    people: people.filter((person) => person.group === group),
  })).filter((section) => section.people.length > 0);

  const upcoming = everyone
    .filter((person) => person.birthday && person.birthday.daysUntil <= BIRTHDAY_HORIZON_DAYS)
    .sort((a, b) => (a.birthday?.daysUntil ?? 0) - (b.birthday?.daysUntil ?? 0));
  const editorAvailability = ownerEditorAvailability({
    formSessionScope: session.formSessionScope,
    editorAvailable: Boolean(editor?.createGrant),
    currentPath: '/people',
  });

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/profile', label: 'Memory' }}
        title="People"
        intro="Open a person to view their details and family connections."
      />
      <MemoryNavigation current="people" />

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionHeading
            title={query ? `Matching “${query}”` : 'People in this view'}
            count={people.length}
            hint={`${people.length} shown in this view`}
          />
          {editor ? <OwnerEditorControls {...editor} /> : null}
        </div>

        {editor?.createGrant ? (
          <p className="mt-3 text-sm text-muted">
            Add people here, then open a person to connect them with someone else.
          </p>
        ) : editorAvailability.kind === 'sign_in_again' ? (
          <p role="status" className="mt-3 text-sm text-muted">
            {editorAvailability.message}
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted">
            Changes are unavailable in this view. You can still browse saved people and connections.
          </p>
        )}

        {/* A GET form, so a search is a URL the owner can bookmark or share
            with themselves, and the page stays a server component. */}
        <form method="get" className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor="people-search" className="sr-only">
            Search people
          </label>
          <span className="relative min-w-0 flex-1 basis-48">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              id="people-search"
              name="q"
              maxLength={120}
              defaultValue={query}
              placeholder="Name, relationship, or place"
              className={`${inputClass} w-full pl-9`}
            />
          </span>
          <button type="submit" className={btn.outline}>
            Search
          </button>
          {query ? (
            <Link href="/people" className={btn.outline}>
              Clear
            </Link>
          ) : null}
        </form>

        {everyone.length === 0 ? (
          <EmptyState>
            {editor?.createGrant
              ? 'No people are available in this view yet. Add a person to start recording their connections.'
              : 'No people are available in this view yet.'}
          </EmptyState>
        ) : people.length === 0 ? (
          <EmptyState>No people match “{query}” in this view.</EmptyState>
        ) : (
          <div className="mt-6 flex flex-col gap-8">
            {byGroup.map((section) => (
              <div key={section.group}>
                <SectionHeading
                  title={PERSON_GROUP_LABELS[section.group as PersonGroup]}
                  count={section.people.length}
                />
                <ul className="mt-3 flex flex-col gap-2">
                  {section.people.map((person) => (
                    <li key={person.id}>
                      <Link
                        href={personHref(person.id)}
                        className="mobile-touch-target flex min-w-0 items-center gap-3 rounded-xl bg-raised p-3.5 ring-1 ring-edge/60 motion-safe:transition-colors hover:bg-sunken/50"
                      >
                        <PersonAvatar name={person.name} />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium text-strong">
                              {person.name}
                            </span>
                            {person.trust === 'unknown' ? (
                              <Badge
                                tone="amber"
                                size="xs"
                                title="The assistant doesn't know who this is yet. Saving a relationship marks them as known."
                              >
                                Unverified
                              </Badge>
                            ) : null}
                          </span>
                          <MetaLine
                            segments={[
                              person.relationship
                                ? `Relationship to you: ${person.relationship}`
                                : 'Relationship to you: not recorded',
                              person.location ? (
                                <>
                                  <MapPin className="size-3" aria-hidden="true" />
                                  {person.location}
                                </>
                              ) : null,
                              lastContactLabel(person.lastContactAt, now),
                              person.birthday ? birthdayLabel(person.birthday, now) : null,
                            ]}
                          />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
      {/* Upcoming dates follow the people management controls. */}
      {upcoming.length > 0 && !query ? (
        <section className="mt-6">
          <SectionHeading title="Coming up in this view" count={upcoming.length} />
          <ul className="mt-3 flex flex-col gap-2">
            {upcoming.map((person) => (
              <li key={person.id}>
                <Link
                  href={personHref(person.id)}
                  className="mobile-touch-target flex min-w-0 items-center gap-3 rounded-xl border border-accent/25 bg-accent/[0.06] p-3.5 motion-safe:transition-colors hover:bg-accent/10"
                >
                  <CalendarDays className="size-4 shrink-0 text-accent" aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-sm text-strong">
                    <span className="font-medium">{person.name}</span>
                    {person.birthday ? ` · ${birthdayLabel(person.birthday, now)}` : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </PageShell>
  );
}
