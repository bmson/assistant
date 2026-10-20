import { listPeopleDirectory, type PersonSummary } from '@assistant/application/people';
import {
  birthdayLabel,
  lastContactLabel,
  PERSON_GROUP_LABELS,
  PERSON_GROUPS,
  type PersonGroup,
} from '@assistant/application/people-presentation';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { CalendarDays, MapPin, Search } from 'lucide-react';
import Link from 'next/link';
import { AddPerson } from '@/app/people/add-person';
import { PersonAvatar } from '@/app/people/person-avatar';
import { requireOwner } from '@/auth';
import { listFirestorePeopleDirectory } from '@/lib/firestore-people';
import { getDb } from '@/lib/server';
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

async function loadPeopleDirectory(now: Date): Promise<PersonSummary[]> {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore') return listPeopleDirectory(getDb(), { now });
  const problems = validateAgentPersistenceConfig(config);
  if (problems.length) throw new Error(problems.join('; '));
  const store = createInstallationStore({
    projectId: config.GCP_PROJECT,
    installationId: config.ASSISTANT_WORKSPACE_ID,
    databaseId: config.FIRESTORE_DATABASE_ID,
  });
  try {
    return await listFirestorePeopleDirectory(store, config.FIRESTORE_AGENT_ID, now);
  } finally {
    await store.db.terminate();
  }
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireOwner();
  const { q } = await searchParams;
  const query = (q ?? '').trim();

  const now = new Date();
  const everyone = await loadPeopleDirectory(now);
  const people = everyone.filter((person) => matches(person, query));

  const byGroup = PERSON_GROUPS.map((group) => ({
    group,
    people: people.filter((person) => person.group === group),
  })).filter((section) => section.people.length > 0);

  const upcoming = everyone
    .filter((person) => person.birthday && person.birthday.daysUntil <= BIRTHDAY_HORIZON_DAYS)
    .sort((a, b) => (a.birthday?.daysUntil ?? 0) - (b.birthday?.daysUntil ?? 0));

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="People"
        intro="Everyone the assistant knows about, and how you are connected. Open someone to see their birthday, their connections, and what you have done together."
      />

      {/* Birthdays first — the one thing on this page that is time-sensitive. */}
      {upcoming.length > 0 && !query ? (
        <section className="mt-6">
          <SectionHeading title="Coming up" count={upcoming.length} />
          <ul className="mt-3 flex flex-col gap-2">
            {upcoming.map((person) => (
              <li key={person.id}>
                <Link
                  href={`/people/${person.id}`}
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

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionHeading
            title={query ? `Matching “${query}”` : 'Everyone'}
            count={everyone.length}
            hint={query ? `${people.length} shown` : undefined}
          />
          <AddPerson />
        </div>

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
            No people yet — names mentioned in conversations become contacts automatically, or add
            someone above.
          </EmptyState>
        ) : people.length === 0 ? (
          <EmptyState>Nobody matches “{query}”.</EmptyState>
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
                        href={`/people/${person.id}`}
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
                              person.relationship || 'Relationship not set',
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
    </PageShell>
  );
}
