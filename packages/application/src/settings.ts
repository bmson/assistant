import { getAgent } from '@assistant/core/chat';
import {
  deleteApprovalPolicyForAgent,
  listApprovalPolicies,
  setApprovalPolicyEnabledForAgent,
} from '@assistant/core/workflow/approval-policies';
import {
  createPostgresApprovalPolicyRepository,
  createPostgresReminderRepository,
  createPostgresScheduleRepository,
  createPostgresSettingsRepository,
  type Db,
} from '@assistant/db';
import type { ApprovalPolicyRepository } from '@assistant/persistence';
import { createSettingsFacade, type SettingsPersistence } from './settings-port.js';

export type { NotificationPrefsView, SettingsOverview } from './settings-port.js';
export {
  createSettingsFacade,
  parseQuietHoursWindow,
  type SettingsPersistence,
} from './settings-port.js';

export function createPostgresSettingsPersistence(db: Db): SettingsPersistence {
  return {
    kind: 'settings-persistence',
    settings: createPostgresSettingsRepository(db),
    schedules: createPostgresScheduleRepository(db),
    reminders: createPostgresReminderRepository(db),
    policies: createPostgresApprovalPolicyRepository(db),
  };
}

const facade = (db: Db) => createSettingsFacade(createPostgresSettingsPersistence(db));

function isSettingsPersistence(source: Db | SettingsPersistence): source is SettingsPersistence {
  return 'kind' in source && source.kind === 'settings-persistence';
}

export function getSettingsOverview(source: Db | SettingsPersistence) {
  const persistence = isSettingsPersistence(source)
    ? source
    : createPostgresSettingsPersistence(source);
  return createSettingsFacade(persistence).getOverview();
}

export function updateNotificationPrefs(
  db: Db,
  input: { quietStart: string; quietEnd: string; ambientDailyCap: string },
) {
  return facade(db).updateNotificationPrefs(input);
}

export function updateAssistantSettings(
  db: Db,
  input: { timezone: string; locale: string; signature: string },
) {
  return facade(db).updateAssistantSettings(input);
}

export function setRecurringJobEnabled(db: Db, scheduleId: string, enabled: boolean) {
  return facade(db).setRecurringJobEnabled(scheduleId, enabled);
}

export function deleteReminder(db: Db, reminderId: string) {
  return facade(db).deleteReminder(reminderId);
}

/** Composition supplies the authenticated installation owner for the portable path. */
export interface ApprovalPolicySettingsStore {
  agentId: string;
  policies: ApprovalPolicyRepository;
}

async function policyContext(store: Db | ApprovalPolicySettingsStore) {
  if ('policies' in store) return { agentId: store.agentId, repository: store.policies };
  return { agentId: (await getAgent(store)).id, repository: store };
}

export async function getApprovalPolicySettings(store: Db | ApprovalPolicySettingsStore) {
  const context = await policyContext(store);
  return listApprovalPolicies(context.repository, context.agentId);
}

export async function setApprovalPolicyEnabled(
  store: Db | ApprovalPolicySettingsStore,
  policyId: string,
  enabled: boolean,
): Promise<void> {
  const context = await policyContext(store);
  await setApprovalPolicyEnabledForAgent(context.repository, context.agentId, policyId, enabled);
}

export async function deleteApprovalPolicy(
  store: Db | ApprovalPolicySettingsStore,
  policyId: string,
): Promise<void> {
  const context = await policyContext(store);
  await deleteApprovalPolicyForAgent(context.repository, context.agentId, policyId);
}
