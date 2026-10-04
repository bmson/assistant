import {
  getCostsDashboard,
  getProfileOverview,
  visibleWorkspaceCapabilityModules,
} from '@assistant/application';
import { loadConfig } from '@assistant/config';
import { assistantModuleMetas } from '@assistant/modules/meta';
import { policyLabels, policyScope, scheduleLabels } from '@/app/settings/labels';
import { getAgentReadinessSource } from '@/lib/agent-readiness-source';
import { capabilityStatus, getCapabilityDiagnostics } from '@/lib/capabilities';
import { coalesce } from '@/lib/coalesce';
import { getFirestoreMobileWorkspace } from '@/lib/firestore-mobile-workspace';
import { getSelfRepairOverview } from '@/lib/self-repair-server';
import {
  getApplication,
  getBillingOverview,
  getDb,
  getWorkspaceSettings,
  MOBILE_BILLING_REFRESH_BUDGET_MS,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * Owner-only, native-ready projections for the secondary workspace surfaces.
 * Keep this separate from the chat bootstrap: chat needs to start immediately,
 * while these richer dashboards only load when their destination opens.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();

  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return mobileJson(
      await coalesce('mobile-workspace', () =>
        getFirestoreMobileWorkspace(getAgentReadinessSource()),
      ),
    );

  const application = getApplication();
  const db = getDb();
  const [
    capabilityDiagnostics,
    currentChats,
    archivedChats,
    profile,
    skills,
    settings,
    costs,
    anomalies,
    improvements,
    imports,
    billing,
  ] = await Promise.all([
    getCapabilityDiagnostics(),
    application.listChatHistory(false),
    application.listChatHistory(true),
    getProfileOverview(db),
    application.listSkills(),
    getWorkspaceSettings(),
    getCostsDashboard(db),
    application.listAnomalies(),
    application.listImprovementProposals(),
    application.getImports(),
    getBillingOverview({ refreshBudgetMs: MOBILE_BILLING_REFRESH_BUDGET_MS }),
  ]);
  const diagnosticsByModule = new Map(
    capabilityDiagnostics.diagnostics.map((diagnostic) => [diagnostic.module, diagnostic]),
  );

  return mobileJson({
    generatedAt: new Date().toISOString(),
    repairs: await getSelfRepairOverview(),
    chats: {
      current: currentChats.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        isPrimary: conversation.isPrimary,
        updatedAt: conversation.updatedAt,
        active: currentChats.activeConversationIds.includes(conversation.id),
      })),
      archived: archivedChats.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        isPrimary: conversation.isPrimary,
        updatedAt: conversation.updatedAt,
        active: archivedChats.activeConversationIds.includes(conversation.id),
      })),
    },
    memory: {
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
    },
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      preconditions: skill.preconditions,
      steps: skill.steps,
      gotchas: skill.gotchas,
      ownerAuthored: skill.ownerAuthored,
      deprecated: skill.deprecated,
      useCount: skill.useCount,
      successCount: skill.successCount,
      failureCount: skill.failureCount,
      updatedAt: skill.updatedAt,
    })),
    capabilities: visibleWorkspaceCapabilityModules(
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
    }),
    settings: {
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
    },
    costs: {
      billing,
      byEvidence: costs.byEvidence,
      dailySpentUsd: costs.totals.dailySpentUsd,
      monthlySpentUsd: costs.totals.monthlySpentUsd,
      heldUsd: costs.totals.heldUsd,
      dailyLimitUsd: Number.isFinite(costs.totals.dailyLimitUsd)
        ? costs.totals.dailyLimitUsd
        : null,
      monthlyLimitUsd: Number.isFinite(costs.totals.monthlyLimitUsd)
        ? costs.totals.monthlyLimitUsd
        : null,
      taskDefaultLimit: costs.taskDefaultLimit,
      parkedTasks: costs.parkedTasks,
      // PostgreSQL's aggregate count is returned as a string by the driver.
      // The native contract uses an integer for both of these values, so
      // normalize it at the API boundary rather than making iOS decode a
      // database representation.
      bySource: costs.bySource.map((row) => ({
        ...row,
        count: Number(row.count),
      })),
      byModel: costs.byModel.map((row) => ({
        ...row,
        count: Number(row.count),
      })),
      held: costs.held,
      topTasks: costs.topTasks,
      recent: costs.recent,
    },
    anomalies: anomalies.map((anomaly) => ({
      id: anomaly.id,
      kind: anomaly.kind,
      toolName: anomaly.toolName,
      detail: anomaly.detail,
      observed: anomaly.observed,
      expected: anomaly.expected,
      citationCount: anomaly.toolCallIds.length,
      hasPolicy: anomaly.policyId !== null,
      createdAt: anomaly.createdAt,
    })),
    improvements: improvements.map((proposal) => {
      const change = (proposal.change ?? {}) as { suggestion?: unknown };
      return {
        id: proposal.id,
        kind: proposal.kind,
        title: proposal.title,
        rationale: proposal.rationale,
        suggestion: typeof change.suggestion === 'string' ? change.suggestion : '',
        evidenceCount: proposal.evidenceIds.length,
        applyable: proposal.kind === 'model_role',
        createdAt: proposal.createdAt,
      };
    }),
    imports: {
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
    },
  });
}
