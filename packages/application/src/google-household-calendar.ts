import { randomUUID } from 'node:crypto';
import {
  type GoogleCalendarConnectionRepository,
  type HouseholdCalendarSettings,
  householdCalendarChoices,
  householdCalendarPurpose,
} from '@assistant/persistence';
import { z } from 'zod';

export const householdCalendarSave = z
  .object({
    connectionId: z.string().uuid(),
    revision: z
      .string()
      .uuid()
      .nullish()
      .transform((value) => value ?? null),
    choices: householdCalendarChoices,
  })
  .strict();
export const householdCalendarPreview = z
  .object({
    connectionId: z.string().uuid(),
    revision: z.string().uuid().nullable(),
    timeMin: z.string().datetime({ offset: true }),
    timeMax: z.string().datetime({ offset: true }),
  })
  .refine(({ timeMin, timeMax }) => {
    const duration = Date.parse(timeMax) - Date.parse(timeMin);
    return duration > 0 && duration <= 26 * 60 * 60 * 1000;
  });

interface CalendarSource {
  id: string;
  name: string;
  accessRole: string;
  primary: boolean;
  dataOwner?: string;
  timeZone?: string;
}
interface Roster {
  calendars: CalendarSource[];
  complete: boolean;
}
interface PreviewWindow {
  timeMin: string;
  timeMax: string;
}
interface PreviewResult {
  complete: boolean;
  rows: Array<{
    id: string;
    title: string;
    calendar: string;
    start: string;
    end: string;
    allDay: boolean;
  }>;
}
interface HouseholdCalendarProvider {
  roster(): Promise<Roster>;
  details(calendar: CalendarSource, window: PreviewWindow): Promise<PreviewResult>;
  busy(calendars: CalendarSource[], window: PreviewWindow): Promise<PreviewResult>;
}

const canShowDetails = (entry: CalendarSource, accountEmail: string) =>
  entry.accessRole === 'owner' &&
  (entry.primary || entry.dataOwner?.toLowerCase() === accountEmail.toLowerCase());
const canShowBusy = (entry: { accessRole: string }) =>
  ['owner', 'writer', 'writerWithoutPrivateAccess', 'reader', 'freeBusyReader'].includes(
    entry.accessRole,
  );

export class HouseholdCalendarConflict extends Error {}

function isExtendedPurpose(purpose: string) {
  return purpose === 'school' || purpose === 'activity' || purpose === 'holidays';
}

function supportedPurpose(purpose: string, supportsExtended: boolean) {
  return (
    householdCalendarPurpose.safeParse(purpose).success &&
    (supportsExtended || !isExtendedPurpose(purpose))
  );
}

function eligible(
  purpose: string,
  calendar: CalendarSource,
  accountEmail: string,
  supportsExtended: boolean,
) {
  if (!supportedPurpose(purpose, supportsExtended)) return false;
  if (purpose === 'ignore') return true;
  if (purpose === 'work_free_busy') return canShowBusy(calendar);
  return canShowDetails(calendar, accountEmail);
}

function setupView(
  connectionId: string,
  household: HouseholdCalendarSettings | undefined,
  roster: Roster,
  accountEmail: string,
  supportsExtended: boolean,
  extendedPurposesAvailable: boolean,
) {
  const purposes = new Map(household?.choices.map(({ id, purpose }) => [id, purpose]));
  const calendars = roster.calendars.map((calendar) => {
    const saved = purposes.get(calendar.id);
    return {
      id: calendar.id,
      name: calendar.name,
      canShowDetails: canShowDetails(calendar, accountEmail),
      canShowBusy: canShowBusy(calendar),
      purpose: saved && eligible(saved, calendar, accountEmail, supportsExtended) ? saved : null,
    };
  });
  const available = new Set(
    calendars.filter(({ purpose }) => purpose !== null).map(({ id }) => id),
  );
  const complete =
    roster.complete &&
    (household?.choices.every(({ id, purpose }) => purpose === 'ignore' || available.has(id)) ??
      true);
  return {
    state: complete ? 'ready' : 'incomplete',
    connectionId,
    extendedPurposesAvailable,
    revision: household?.revision ?? null,
    remaining: complete ? calendars.filter(({ purpose }) => purpose === null).length : null,
    calendars,
  };
}

export function createGoogleHouseholdCalendarService(
  repository: GoogleCalendarConnectionRepository,
  makeProvider: (
    ownerId: string,
    connectionId: string,
    assertCurrent: () => Promise<void>,
  ) => HouseholdCalendarProvider,
  extendedPurposesEnabled = false,
) {
  async function open(
    ownerId: string,
    expected?: { connectionId: string; revision: string | null },
  ) {
    const state = await repository.get(ownerId);
    const connection = state?.connection;
    if (!state || !connection || connection.status === 'reconnect_required')
      throw new Error('Personal Calendar unavailable');
    const connectionId = connection.id;
    const revision = state.household?.revision ?? null;
    if (expected && (expected.connectionId !== connectionId || expected.revision !== revision))
      throw new HouseholdCalendarConflict();
    const assertCurrent = async () => {
      const current = await repository.get(ownerId);
      if (
        current?.connection?.id !== connectionId ||
        current.connection.status !== 'connected' ||
        (current.household?.revision ?? null) !== revision
      )
        throw new HouseholdCalendarConflict();
    };
    const provider = makeProvider(ownerId, connectionId, assertCurrent);
    const roster = await provider.roster();
    await assertCurrent();
    return {
      provider,
      roster,
      connectionId,
      accountEmail: connection.account.email,
      household: state.household,
      assertCurrent,
    };
  }

  return {
    async setup(ownerId: string, supportsExtended = false) {
      const current = await open(ownerId);
      return setupView(
        current.connectionId,
        current.household,
        current.roster,
        current.accountEmail,
        supportsExtended,
        supportsExtended && extendedPurposesEnabled,
      );
    },
    async save(
      ownerId: string,
      input: z.infer<typeof householdCalendarSave>,
      supportsExtended = false,
    ) {
      const current = await open(ownerId, input);
      if (!current.roster.complete) throw new Error('Household calendar roster incomplete');
      if (
        current.household?.choices.some(
          ({ purpose }) => !supportedPurpose(purpose, supportsExtended),
        )
      )
        throw new HouseholdCalendarConflict();
      const rosterById = new Map(
        current.roster.calendars.map((calendar) => [calendar.id, calendar]),
      );
      const prior = new Map(current.household?.choices.map(({ id, purpose }) => [id, purpose]));
      for (const choice of input.choices) {
        const calendar = rosterById.get(choice.id);
        if (
          !calendar ||
          !eligible(choice.purpose, calendar, current.accountEmail, supportsExtended) ||
          (isExtendedPurpose(choice.purpose) &&
            !extendedPurposesEnabled &&
            prior.get(choice.id) !== choice.purpose)
        )
          throw new HouseholdCalendarConflict();
      }
      const submitted = new Set(input.choices.map(({ id }) => id));
      const held =
        current.household?.choices.filter(({ id, purpose }) => {
          if (submitted.has(id)) return false;
          const calendar = rosterById.get(id);
          return !calendar || !eligible(purpose, calendar, current.accountEmail, supportsExtended);
        }) ?? [];
      const settings = { revision: randomUUID(), choices: [...input.choices, ...held] };
      if (!(await repository.saveHousehold(ownerId, input.connectionId, input.revision, settings)))
        throw new HouseholdCalendarConflict();
      const persisted = await repository.get(ownerId);
      if (
        persisted?.connection?.id !== input.connectionId ||
        persisted.connection.status !== 'connected' ||
        persisted.household?.revision !== settings.revision
      )
        throw new HouseholdCalendarConflict();
      return setupView(
        input.connectionId,
        persisted.household,
        current.roster,
        current.accountEmail,
        supportsExtended,
        supportsExtended && extendedPurposesEnabled,
      );
    },
    async preview(
      ownerId: string,
      input: z.infer<typeof householdCalendarPreview>,
      supportsExtended = false,
    ) {
      const current = await open(ownerId, input);
      if (!current.roster.complete) return { complete: false, rows: [] };
      const choices = new Map(current.household?.choices.map(({ id, purpose }) => [id, purpose]));
      const details = current.roster.calendars.filter((entry) => {
        const purpose = choices.get(entry.id);
        return (
          purpose !== undefined &&
          (purpose === 'household' || isExtendedPurpose(purpose)) &&
          eligible(purpose, entry, current.accountEmail, supportsExtended)
        );
      });
      const busy = current.roster.calendars.filter(
        (entry) => choices.get(entry.id) === 'work_free_busy' && canShowBusy(entry),
      );
      const window = { timeMin: input.timeMin, timeMax: input.timeMax };
      const results = [];
      // Bound provider fan-out. Do not request details for Work or any excluded calendar.
      for (const entry of details) {
        results.push(await current.provider.details(entry, window));
      }
      if (busy.length) results.push(await current.provider.busy(busy, window));
      await current.assertCurrent();
      const included = new Set([...details, ...busy].map(({ id }) => id));
      const complete =
        results.every((result) => result.complete) &&
        [...choices].every(([id, purpose]) => purpose === 'ignore' || included.has(id));
      const ordered = results
        .flatMap(({ rows }) => rows)
        .sort((a, b) => a.start.localeCompare(b.start));
      const rows = [...new Map(ordered.map((row) => [row.id, row])).values()];
      return { complete, rows };
    },
  };
}
