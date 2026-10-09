import {
  getImportOverview,
  getProfileOverview,
  listMobileWorkspaceCapabilities,
  projectMobileWorkspaceMemory,
} from '@assistant/application';
import { loadConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  FirestoreImportOverviewRepository,
  FirestoreProfileOverviewRepository,
  FirestoreWorkspaceCapabilityRepository,
  getFirestoreMobileCosts,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { assistantModuleMetas } from '@assistant/modules/meta';
import type { AgentReadinessSource } from '@assistant/persistence';
import { policyLabels, policyScope, scheduleLabels } from '@/app/settings/labels';
import { getSelfRepairOverview } from '@/lib/self-repair-server';
import { readMobileWorkspaceSection } from './mobile-workspace-sections';
import {
  getBillingOverview,
  getFirestoreInstallationStore,
  getMobileWorkspaceSectionPage,
  getWorkspace,
  getWorkspaceSettings,
  MOBILE_BILLING_REFRESH_BUDGET_MS,
} from './server';

/** Compose the existing native workspace contract entirely from customer-owned stores. */
export async function getFirestoreMobileWorkspace(
  readinessSource: AgentReadinessSource,
  options: {
    sectionTimeoutMs?: number;
    billingTimeoutMs?: number;
    billingReader?: typeof getBillingOverview;
  } = {},
) {
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER !== 'firestore')
    throw new Error('Firestore mobile workspace requires Firestore persistence');
  const store = getFirestoreInstallationStore();
  const agentId = config.FIRESTORE_AGENT_ID;
  const sectionTimeoutMs = options.sectionTimeoutMs ?? 4_000;
  const privacyFence = await readPrivacyErasureFence(store, agentId);
  const [
    chatsSection,
    memorySection,
    skillsSection,
    settingsSection,
    costsSection,
    anomaliesSection,
    improvementsSection,
    importsSection,
    capabilitiesSection,
    billingSection,
    repairsSection,
  ] = await Promise.all([
    readMobileWorkspaceSection(async () => {
      const [current, archived] = await Promise.all([
        getMobileWorkspaceSectionPage({
          section: 'chats',
          archived: false,
          limit: 50,
          cursor: null,
        }),
        getMobileWorkspaceSectionPage({
          section: 'chats',
          archived: true,
          limit: 50,
          cursor: null,
        }),
      ]);
      return { current, archived };
    }, sectionTimeoutMs),
    readMobileWorkspaceSection(
      () => getProfileOverview(new FirestoreProfileOverviewRepository(store, agentId)),
      sectionTimeoutMs,
    ),
    readMobileWorkspaceSection(
      () =>
        getMobileWorkspaceSectionPage({
          section: 'skills',
          archived: false,
          limit: 50,
          cursor: null,
        }),
      sectionTimeoutMs,
    ),
    readMobileWorkspaceSection(() => getWorkspaceSettings(), sectionTimeoutMs),
    readMobileWorkspaceSection(() => getFirestoreMobileCosts(store, agentId), sectionTimeoutMs),
    readMobileWorkspaceSection(
      () =>
        getMobileWorkspaceSectionPage({
          section: 'anomalies',
          archived: false,
          limit: 50,
          cursor: null,
        }),
      sectionTimeoutMs,
    ),
    readMobileWorkspaceSection(
      () =>
        getMobileWorkspaceSectionPage({
          section: 'improvements',
          archived: false,
          limit: 50,
          cursor: null,
        }),
      sectionTimeoutMs,
    ),
    readMobileWorkspaceSection(
      () =>
        getImportOverview(new FirestoreImportOverviewRepository(store, agentId), getWorkspace()),
      sectionTimeoutMs,
    ),
    readMobileWorkspaceSection(
      () =>
        listMobileWorkspaceCapabilities(
          new FirestoreWorkspaceCapabilityRepository(store, agentId, readinessSource),
          agentId,
          assistantModuleMetas,
          config.ASSISTANT_MODULES,
        ),
      sectionTimeoutMs,
    ),
    readMobileWorkspaceSection(
      () =>
        (options.billingReader ?? getBillingOverview)({
          refreshBudgetMs: MOBILE_BILLING_REFRESH_BUDGET_MS,
        }),
      options.billingTimeoutMs ?? sectionTimeoutMs,
    ),
    readMobileWorkspaceSection(() => getSelfRepairOverview(), sectionTimeoutMs),
  ]);

  const currentChats = chatsSection.value?.current;
  const archivedChats = chatsSection.value?.archived;
  const profile = memorySection.value;
  const skills = skillsSection.value;
  const settings = settingsSection.value;
  const costs = costsSection.value;
  const anomalies = anomaliesSection.value;
  const improvements = improvementsSection.value;
  const imports = importsSection.value;
  const capabilities = capabilitiesSection.value;
  const billing = billingSection.value;
  const repairs = repairsSection.value;

  const conversations = (history: NonNullable<typeof currentChats>) => history.items;

  // Each section checks its own scope. The outer fence also prevents a mixed
  // response if erasure starts between otherwise individually valid reads.
  await assertPrivacyErasureFenceUnchanged(store, agentId, privacyFence);

  return {
    generatedAt: new Date().toISOString(),
    repairs,
    sectionAvailability: {
      chats: chatsSection.availability,
      memory: memorySection.availability,
      skills: skillsSection.availability,
      capabilities: capabilitiesSection.availability,
      settings: settingsSection.availability,
      costs: costsSection.availability,
      billing: billingSection.availability,
      anomalies: anomaliesSection.availability,
      improvements: improvementsSection.availability,
      imports: importsSection.availability,
      importSources: imports?.sourceAvailability ?? importsSection.availability,
      importFiles: imports?.filesAvailability ?? importsSection.availability,
      repairs: repairsSection.availability,
    },
    sectionPagination: {
      chats: {
        current: {
          endpoint: '/api/mobile/v1/workspace/sections/chats',
          pageSize: 50,
          loaded: currentChats?.items.length ?? 0,
          hasMore: currentChats?.hasMore ?? false,
          complete: currentChats ? !currentChats.hasMore : false,
          nextCursor: currentChats?.nextCursor ?? null,
          archived: false,
        },
        archived: {
          endpoint: '/api/mobile/v1/workspace/sections/chats',
          pageSize: 50,
          loaded: archivedChats?.items.length ?? 0,
          hasMore: archivedChats?.hasMore ?? false,
          complete: archivedChats ? !archivedChats.hasMore : false,
          nextCursor: archivedChats?.nextCursor ?? null,
          archived: true,
        },
      },
      skills: {
        endpoint: '/api/mobile/v1/workspace/sections/skills',
        pageSize: 50,
        loaded: skills?.items.length ?? 0,
        hasMore: skills?.hasMore ?? false,
        complete: skills ? !skills.hasMore : false,
        nextCursor: skills?.nextCursor ?? null,
      },
      anomalies: {
        endpoint: '/api/mobile/v1/workspace/sections/anomalies',
        pageSize: 50,
        loaded: anomalies?.items.length ?? 0,
        hasMore: anomalies?.hasMore ?? false,
        complete: anomalies ? !anomalies.hasMore : false,
        nextCursor: anomalies?.nextCursor ?? null,
      },
      improvements: {
        endpoint: '/api/mobile/v1/workspace/sections/improvements',
        pageSize: 50,
        loaded: improvements?.items.length ?? 0,
        hasMore: improvements?.hasMore ?? false,
        complete: improvements ? !improvements.hasMore : false,
        nextCursor: improvements?.nextCursor ?? null,
      },
      importSources: {
        endpoint: '/api/mobile/v1/workspace/sections/import-sources',
        pageSize: 50,
        consistency: imports?.sourcePagination.consistency ?? 'live-keyset',
        loaded: imports?.sources.length ?? 0,
        hasMore: imports?.sourcePagination.hasMore ?? false,
        complete:
          imports?.sourceAvailability.status === 'available'
            ? !imports.sourcePagination.hasMore
            : false,
        nextCursor: imports?.sourcePagination.nextCursor ?? null,
      },
      importFiles: {
        endpoint: '/api/mobile/v1/workspace/sections/import-files',
        pageSize: 50,
        consistency: imports?.filesPagination.consistency ?? 'unavailable',
        loaded: imports?.unstartedFiles.length ?? 0,
        hasMore: imports?.filesPagination.hasMore ?? false,
        complete:
          imports?.filesAvailability.status === 'available'
            ? !imports.filesPagination.hasMore
            : false,
        nextCursor: imports?.filesPagination.nextCursor ?? null,
      },
    },
    chats:
      currentChats && archivedChats
        ? { current: conversations(currentChats), archived: conversations(archivedChats) }
        : { current: [], archived: [] },
    memory: profile
      ? projectMobileWorkspaceMemory(profile)
      : {
          ownerName: null,
          ownerContactId: null,
          health: {
            totalUsable: 0,
            notYetOrganized: 0,
            awaitingReview: 0,
            ownerConfirmed: 0,
            lastOrganizedAt: null,
          },
          facts: [],
          awaitingReview: [],
          peopleCount: 0,
          people: [],
          card: null,
          voiceStats: null,
          latestOrganizer: null,
        },
    skills: skills?.items ?? [],
    capabilities: capabilities ?? [],
    settings: settings
      ? {
          agent: {
            name: settings.agent.name,
            timezone: settings.agent.timezone,
            locale: settings.agent.locale,
            signature: settings.agent.signature,
          },
          schedules: settings.schedules
            .filter((schedule) => !schedule.name.startsWith('reminder:'))
            .map((schedule) => ({
              id: schedule.id,
              name: schedule.name,
              label: scheduleLabels[schedule.name] ?? null,
              cron: schedule.cron,
              enabled: schedule.enabled,
              nextRunAt: schedule.nextRunAt,
              lastRunAt: schedule.lastRunAt,
            })),
          reminders: settings.reminders,
          policies: settings.policies.map((policy) => ({
            id: policy.id,
            toolName: policy.toolName,
            templateKey: policy.templateKey,
            label: policyLabels[policy.templateKey] ?? null,
            scope: policyScope(policy.templateKey, policy.match),
            effect: policy.effect,
            enabled: policy.enabled,
            createdVia: policy.createdVia,
          })),
          goalAutomationCount: settings.goalAutomationCount,
        }
      : {
          agent: { name: '', timezone: '', locale: '', signature: '' },
          schedules: [],
          reminders: [],
          policies: [],
          goalAutomationCount: 0,
        },
    costs: {
      billing: billing ?? [],
      byEvidence: costs?.byEvidence ?? [],
      dailySpentUsd: costs?.totals.dailySpentUsd ?? 0,
      monthlySpentUsd: costs?.totals.monthlySpentUsd ?? 0,
      heldUsd: costs?.totals.heldUsd ?? 0,
      dailyLimitUsd:
        costs && Number.isFinite(costs.totals.dailyLimitUsd) ? costs.totals.dailyLimitUsd : null,
      monthlyLimitUsd:
        costs && Number.isFinite(costs.totals.monthlyLimitUsd)
          ? costs.totals.monthlyLimitUsd
          : null,
      taskDefaultLimit: costs?.taskDefaultLimit ?? null,
      parkedTasks: costs?.parkedTasks ?? 0,
      bySource: costs?.bySource ?? [],
      byModel: costs?.byModel ?? [],
      held: costs?.held ?? [],
      topTasks: costs?.topTasks ?? [],
      recent: costs?.recent ?? [],
    },
    anomalies: anomalies?.items ?? [],
    improvements: improvements?.items ?? [],
    imports: imports
      ? {
          sources: imports.sources.map((source) => ({
            source: source.source,
            workspacePath: source.workspacePath,
            kind: source.kind,
            status: source.status,
            itemsTotal: source.itemsTotal,
            itemsProcessed: source.itemsProcessed,
            memoriesSaved: source.memoriesSaved,
            quarantinedNow: imports.quarantineBySource[source.source] ?? 0,
            taskId: source.taskId,
            error: source.error,
            updatedAt: source.updatedAt,
          })),
          unstartedFiles: imports.unstartedFiles,
          sourceAvailability: imports.sourceAvailability,
          filesAvailability: imports.filesAvailability,
        }
      : { sources: [], unstartedFiles: [] },
  };
}
