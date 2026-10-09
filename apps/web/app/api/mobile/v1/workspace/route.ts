import { visibleWorkspaceCapabilityModules } from '@assistant/application';
import { loadConfig } from '@assistant/config';
import { assistantModuleMetas } from '@assistant/modules/meta';
import { policyLabels, policyScope, scheduleLabels } from '@/app/settings/labels';
import { getAgentReadinessSource } from '@/lib/agent-readiness-source';
import { capabilityStatus, getCapabilityDiagnostics } from '@/lib/capabilities';
import { getFirestoreMobileWorkspace } from '@/lib/firestore-mobile-workspace';
import { readMobileWorkspaceSection } from '@/lib/mobile-workspace-sections';
import { getSelfRepairOverview } from '@/lib/self-repair-server';
import {
  getBillingOverview,
  MOBILE_BILLING_REFRESH_BUDGET_MS,
  withPostgresMobileWorkspaceRead,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

function workspaceResponse(
  request: Request,
  payload: {
    sectionAvailability: Record<string, { status: string; version: number; message?: string }>;
  },
): Response {
  const supportsSections = request.headers.get('x-assistant-workspace-sections') === '1';
  const unavailable = Object.values(payload.sectionAvailability).some(
    (section) => section.status !== 'available' || section.version !== 1,
  );
  // Older native clients cannot distinguish a placeholder from a genuine
  // empty list. Keep their old fail-closed response until they advertise the
  // typed per-section contract.
  if (unavailable && !supportsSections)
    return mobileJson(
      {
        error: 'A workspace section is unavailable. Update the app to view sections independently.',
      },
      { status: 503 },
    );
  return mobileJson(payload);
}

/**
 * Owner-only, native-ready projections for the secondary workspace surfaces.
 * Keep this separate from the chat bootstrap: chat needs to start immediately,
 * while these richer dashboards only load when their destination opens.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();

  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return workspaceResponse(request, await getFirestoreMobileWorkspace(getAgentReadinessSource()));

  try {
    return await withPostgresMobileWorkspaceRead(async ({ ownerId, application }) => {
      const [
        capabilityResult,
        chatsResult,
        profileResult,
        skillsResult,
        settingsResult,
        costsResult,
        anomaliesResult,
        improvementsResult,
        importsResult,
        billingResult,
        repairsResult,
      ] = await Promise.all([
        readMobileWorkspaceSection(() => getCapabilityDiagnostics()),
        readMobileWorkspaceSection(async () => {
          const [current, archived] = await Promise.all([
            application.getWorkspacePage({
              section: 'chats',
              ownerId,
              archived: false,
              limit: 50,
            }),
            application.getWorkspacePage({
              section: 'chats',
              ownerId,
              archived: true,
              limit: 50,
            }),
          ]);
          return { current, archived };
        }),
        readMobileWorkspaceSection(() => application.getProfileOverview()),
        readMobileWorkspaceSection(() =>
          application.getWorkspacePage({
            section: 'skills',
            ownerId,
            archived: false,
            limit: 50,
          }),
        ),
        readMobileWorkspaceSection(() => application.getSettings()),
        readMobileWorkspaceSection(() => application.getCostsDashboard()),
        readMobileWorkspaceSection(() =>
          application.getWorkspacePage({
            section: 'anomalies',
            ownerId,
            archived: false,
            limit: 50,
          }),
        ),
        readMobileWorkspaceSection(() =>
          application.getWorkspacePage({
            section: 'improvements',
            ownerId,
            archived: false,
            limit: 50,
          }),
        ),
        readMobileWorkspaceSection(() => application.getImports()),
        readMobileWorkspaceSection(() =>
          getBillingOverview({ refreshBudgetMs: MOBILE_BILLING_REFRESH_BUDGET_MS }),
        ),
        readMobileWorkspaceSection(() => getSelfRepairOverview()),
      ]);
      const capabilityDiagnostics = capabilityResult.value;
      const currentChats = chatsResult.value?.current;
      const archivedChats = chatsResult.value?.archived;
      const profile = profileResult.value;
      const skills = skillsResult.value;
      const settings = settingsResult.value;
      const costs = costsResult.value;
      const anomalies = anomaliesResult.value;
      const improvements = improvementsResult.value;
      const imports = importsResult.value;
      const billing = billingResult.value;
      const repairs = repairsResult.value;
      const diagnosticsByModule = new Map(
        (capabilityDiagnostics?.diagnostics ?? []).map((diagnostic) => [
          diagnostic.module,
          diagnostic,
        ]),
      );

      const payload = {
        generatedAt: new Date().toISOString(),
        sectionAvailability: {
          chats: chatsResult.availability,
          memory: profileResult.availability,
          skills: skillsResult.availability,
          capabilities: capabilityResult.availability,
          settings: settingsResult.availability,
          costs: costsResult.availability,
          billing: billingResult.availability,
          anomalies: anomaliesResult.availability,
          improvements: improvementsResult.availability,
          imports: importsResult.availability,
          importSources: imports?.sourceAvailability ?? importsResult.availability,
          importFiles: imports?.filesAvailability ?? importsResult.availability,
          repairs: repairsResult.availability,
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
        repairs,
        chats:
          currentChats && archivedChats
            ? {
                current: currentChats.items,
                archived: archivedChats.items,
              }
            : { current: [], archived: [] },
        memory: profile
          ? {
              ownerName: profile.owner?.name ?? null,
              ownerContactId: profile.owner?.id ?? null,
              health: profile.memoryHealth,
              facts: profile.ownerFacts.slice(0, 80).map((fact) => ({
                id: fact.id,
                content: fact.content,
                kind: fact.kind,
                domain: fact.domain,
                ownerConfirmed: fact.ownerConfirmed,
                pinned: fact.pinned,
                importance: fact.importance,
                createdAt: fact.createdAt,
              })),
              awaitingReview: profile.quarantined.slice(0, 40).map((fact) => ({
                id: fact.id,
                content: fact.content,
                kind: fact.kind,
                domain: fact.domain,
                ownerConfirmed: fact.ownerConfirmed,
                pinned: fact.pinned,
                importance: fact.importance,
                createdAt: fact.createdAt,
              })),
              peopleCount: profile.people.length,
              people: profile.people.map(({ contact, factCount }) => ({
                id: contact.id,
                name: contact.name,
                aliases: contact.aliases,
                relationship: contact.relationship,
                trust: contact.trust,
                factCount,
              })),
              card: profile.card,
              voiceStats: profile.voiceStats,
              latestOrganizer: profile.latestOrganizer,
            }
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
        capabilities: capabilityDiagnostics
          ? visibleWorkspaceCapabilityModules(
              assistantModuleMetas,
              capabilityDiagnostics.diagnostics,
            ).map((meta) => {
              const diagnostic = diagnosticsByModule.get(meta.name);
              const enabled = diagnostic?.enabled ?? false;
              const ready = diagnostic?.ready ?? false;
              return {
                id: meta.name,
                title: meta.title,
                summary: meta.summary,
                enabled,
                ready,
                status: capabilityStatus({ enabled, ready }, capabilityDiagnostics.statusAvailable),
                detail: diagnostic?.detail ?? 'unavailable',
              };
            })
          : [],
        settings: settings
          ? {
              agent: {
                name: settings.agent.name,
                timezone: settings.agent.timezone,
                locale: settings.agent.locale,
                signature: settings.agent.signature,
              },
              // `label` carries the same human wording the web settings page shows,
              // so the phone never has to keep its own copy of the dictionaries.
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
            costs && Number.isFinite(costs.totals.dailyLimitUsd)
              ? costs.totals.dailyLimitUsd
              : null,
          monthlyLimitUsd:
            costs && Number.isFinite(costs.totals.monthlyLimitUsd)
              ? costs.totals.monthlyLimitUsd
              : null,
          taskDefaultLimit: costs?.taskDefaultLimit ?? null,
          parkedTasks: costs?.parkedTasks ?? 0,
          // PostgreSQL's aggregate count is returned as a string by the driver.
          // The native contract uses an integer for both of these values, so
          // normalize it at the API boundary rather than making iOS decode a
          // database representation.
          bySource: (costs?.bySource ?? []).map((row) => ({
            ...row,
            count: Number(row.count),
          })),
          byModel: (costs?.byModel ?? []).map((row) => ({
            ...row,
            count: Number(row.count),
          })),
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
      return workspaceResponse(request, payload);
    });
  } catch {
    return mobileJson(
      { error: 'Workspace privacy status is unavailable. Retry before viewing private data.' },
      { status: 503 },
    );
  }
}
