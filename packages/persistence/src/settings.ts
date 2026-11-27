import type { Records } from './records.js';

export type OwnerSettings = Pick<
  Records['agents'],
  | 'id'
  | 'name'
  | 'email'
  | 'calendarId'
  | 'phoneE164'
  | 'avatarUrl'
  | 'signature'
  | 'timezone'
  | 'locale'
  | 'workspacePrefix'
  | 'browserProfilePath'
  | 'credentialRefs'
  | 'createdAt'
  | 'updatedAt'
>;

export interface NotificationPreferenceSettings {
  quietStartMin: number | null;
  quietEndMin: number | null;
  ambientDailyCap: number | null;
}

export type QuietHoursWindow = Pick<
  NotificationPreferenceSettings,
  'quietStartMin' | 'quietEndMin'
>;

export interface HeldPingCounts {
  quietHours: number;
  dailyCap: number;
}

export interface SettingsRepository {
  readonly kind: 'settings-repository';
  getOwner(): Promise<OwnerSettings | null>;
  getNotificationPrefs(agentId: string): Promise<NotificationPreferenceSettings | null>;
  countHeldPings(agentId: string, since: Date): Promise<HeldPingCounts>;
  updateNotificationPrefs(agentId: string, input: NotificationPreferenceSettings): Promise<boolean>;
  updateQuietHours(agentId: string, window: QuietHoursWindow): Promise<boolean>;
  updateOwner(
    agentId: string,
    input: { timezone: string; locale: string; signature: string },
  ): Promise<boolean>;
}
