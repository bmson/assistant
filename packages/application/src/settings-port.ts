import type {
  ApprovalPolicyRepository,
  OwnerSettings,
  ReminderRepository,
  ScheduleRecord,
  ScheduleRepository,
  SettingsRepository,
} from '@assistant/persistence';
import { reminderScheduleIsActive, reminderScheduleTemplate } from '@assistant/persistence';

export interface NotificationPrefsView {
  quietStart: string;
  quietEnd: string;
  ambientDailyCap: string;
  heldLast24h: { quietHours: number; dailyCap: number };
}

export interface SettingsOverview {
  agent: OwnerSettings;
  schedules: ScheduleRecord[];
  reminders: Array<{
    id: string;
    text: string;
    kind: 'once' | 'recurring' | 'event_completion';
    status: 'scheduled' | 'delivering';
    nextRunAt: Date | null;
  }>;
  policies: Awaited<ReturnType<ApprovalPolicyRepository['list']>>;
  goalAutomationCount: number;
  notificationPrefs: NotificationPrefsView;
}

export interface SettingsPersistence {
  readonly kind: 'settings-persistence';
  settings: SettingsRepository;
  schedules: ScheduleRepository;
  reminders: ReminderRepository;
  policies: ApprovalPolicyRepository;
}

function minutesToHHMM(minutes: number | null): string {
  if (minutes == null) return '';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseHHMM(value: string): { ok: true; minutes: number | null } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, minutes: null };
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return { ok: false };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return { ok: false };
  return { ok: true, minutes: hours * 60 + minutes };
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

async function allSchedules(repository: ScheduleRepository, agentId: string) {
  const rows: ScheduleRecord[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const result = await repository.listPage(agentId, { afterId, limit: 200 });
    if (result.items.some((row) => row.agentId !== agentId))
      throw new Error('Schedule owner mismatch');
    rows.push(...result.items);
    if (result.nextCursor === null) return rows;
    if (!result.items.length || result.nextCursor === afterId)
      throw new Error('Schedule cursor did not advance');
    afterId = result.nextCursor;
  }
  throw new Error(
    'Too many schedules to safely complete this lookup; use a reminder ID for cancellation',
  );
}

export function createSettingsFacade(
  persistence: SettingsPersistence,
  now: () => Date = () => new Date(),
) {
  const owner = async () => {
    const row = await persistence.settings.getOwner();
    if (!row) throw new Error('No agent configured.');
    return row;
  };
  return {
    async getOverview(): Promise<SettingsOverview> {
      const agent = await owner();
      const [scheduleRows, policies, prefs, heldLast24h] = await Promise.all([
        allSchedules(persistence.schedules, agent.id),
        persistence.policies.list(agent.id),
        persistence.settings.getNotificationPrefs(agent.id),
        persistence.settings.countHeldPings(agent.id, new Date(now().getTime() - 24 * 3600 * 1000)),
      ]);
      scheduleRows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const reminderSchedules = scheduleRows.filter((row) => row.name.startsWith('reminder:'));
      return {
        agent,
        schedules: scheduleRows.filter(
          (row) => !row.name.startsWith('goal:') && !row.name.startsWith('reminder:'),
        ),
        reminders: reminderSchedules.filter(reminderScheduleIsActive).map((row) => {
          const template = reminderScheduleTemplate(row.taskTemplate);
          return {
            id: row.id,
            text: template.reminderText ?? '',
            kind: template.reminderKind ?? ('recurring' as const),
            status: row.enabled ? ('scheduled' as const) : ('delivering' as const),
            nextRunAt: row.nextRunAt,
          };
        }),
        policies,
        goalAutomationCount: scheduleRows.filter((row) => row.name.startsWith('goal:')).length,
        notificationPrefs: {
          quietStart: minutesToHHMM(prefs?.quietStartMin ?? null),
          quietEnd: minutesToHHMM(prefs?.quietEndMin ?? null),
          ambientDailyCap: prefs?.ambientDailyCap == null ? '' : String(prefs.ambientDailyCap),
          heldLast24h,
        },
      };
    },
    async updateNotificationPrefs(input: {
      quietStart: string;
      quietEnd: string;
      ambientDailyCap: string;
    }): Promise<{ error?: string }> {
      const start = parseHHMM(input.quietStart);
      const end = parseHHMM(input.quietEnd);
      if (!start.ok || !end.ok) return { error: 'Quiet hours need HH:MM times, or be left empty.' };
      const capRaw = input.ambientDailyCap.trim();
      let ambientDailyCap: number | null = null;
      if (capRaw !== '') {
        const parsed = Number(capRaw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
          return { error: 'The daily ping limit must be a whole number between 1 and 100.' };
        ambientDailyCap = parsed;
      }
      const agent = await persistence.settings.getOwner();
      if (!agent) return { error: 'No agent configured.' };
      const both = start.minutes != null && end.minutes != null;
      const updated = await persistence.settings.updateNotificationPrefs(agent.id, {
        quietStartMin: both ? start.minutes : null,
        quietEndMin: both ? end.minutes : null,
        ambientDailyCap,
      });
      return updated ? {} : { error: 'No agent configured.' };
    },
    async updateAssistantSettings(input: {
      timezone: string;
      locale: string;
      signature: string;
    }): Promise<{ error?: string }> {
      const timezone = input.timezone.trim();
      const locale = input.locale.trim().slice(0, 20);
      if (!isValidTimezone(timezone)) return { error: `Unknown timezone "${timezone}".` };
      if (!locale) return { error: 'Locale is required.' };
      const agent = await persistence.settings.getOwner();
      if (!agent) return { error: 'No agent configured.' };
      const updated = await persistence.settings.updateOwner(agent.id, {
        timezone,
        locale,
        signature: input.signature.trim().slice(0, 500),
      });
      return updated ? {} : { error: 'No agent configured.' };
    },
    async setRecurringJobEnabled(scheduleId: string, enabled: boolean) {
      const agent = await owner();
      return persistence.schedules.setOwnerEnabled(agent.id, scheduleId, enabled);
    },
    async deleteReminder(reminderId: string) {
      const agent = await owner();
      return (await persistence.reminders.cancel(agent.id, reminderId, now())).cancelled;
    },
    async setApprovalPolicyEnabled(policyId: string, enabled: boolean): Promise<void> {
      const agent = await owner();
      await persistence.policies.setEnabled(agent.id, policyId, enabled);
    },
    async deleteApprovalPolicy(policyId: string): Promise<void> {
      const agent = await owner();
      await persistence.policies.delete(agent.id, policyId);
    },
  };
}
