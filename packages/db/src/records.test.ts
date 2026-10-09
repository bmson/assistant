import type { Records } from '@assistant/persistence';
import { expectTypeOf, it } from 'vitest';
import type * as schema from './schema.js';

it('keeps portable record types compatible with all PostgreSQL tables', () => {
  type SchemaTables = {
    [Key in keyof typeof schema]: (typeof schema)[Key] extends { $inferSelect: unknown }
      ? Key
      : never;
  }[keyof typeof schema];
  expectTypeOf<keyof Records>().toEqualTypeOf<SchemaTables>();

  expectTypeOf<Records['maintenanceCursors']>().toEqualTypeOf<
    typeof schema.maintenanceCursors.$inferSelect
  >();
  expectTypeOf<Records['situationPacks']>().toEqualTypeOf<
    typeof schema.situationPacks.$inferSelect
  >();
  expectTypeOf<Records['situationPreviews']>().toEqualTypeOf<
    typeof schema.situationPreviews.$inferSelect
  >();
  expectTypeOf<Records['agents']>().toEqualTypeOf<typeof schema.agents.$inferSelect>();
  expectTypeOf<Records['mcpConnections']>().toEqualTypeOf<
    typeof schema.mcpConnections.$inferSelect
  >();
  expectTypeOf<Records['goals']>().toEqualTypeOf<typeof schema.goals.$inferSelect>();
  expectTypeOf<Records['conversations']>().toEqualTypeOf<
    typeof schema.conversations.$inferSelect
  >();
  expectTypeOf<Records['channelBindings']>().toEqualTypeOf<
    typeof schema.channelBindings.$inferSelect
  >();
  expectTypeOf<Records['messages']>().toEqualTypeOf<typeof schema.messages.$inferSelect>();
  expectTypeOf<Records['generatedCards']>().toEqualTypeOf<
    typeof schema.generatedCards.$inferSelect
  >();
  expectTypeOf<Records['generatedCardRevisions']>().toEqualTypeOf<
    typeof schema.generatedCardRevisions.$inferSelect
  >();
  expectTypeOf<Records['commitments']>().toEqualTypeOf<typeof schema.commitments.$inferSelect>();
  expectTypeOf<Records['conversationSegments']>().toEqualTypeOf<
    typeof schema.conversationSegments.$inferSelect
  >();
  expectTypeOf<Records['tasks']>().toEqualTypeOf<typeof schema.tasks.$inferSelect>();
  expectTypeOf<Records['toolCalls']>().toEqualTypeOf<typeof schema.toolCalls.$inferSelect>();
  expectTypeOf<Records['approvals']>().toEqualTypeOf<typeof schema.approvals.$inferSelect>();
  expectTypeOf<Records['applicationConfirmations']>().toEqualTypeOf<
    typeof schema.applicationConfirmations.$inferSelect
  >();
  expectTypeOf<Records['approvalPolicies']>().toEqualTypeOf<
    typeof schema.approvalPolicies.$inferSelect
  >();
  expectTypeOf<Records['anomalies']>().toEqualTypeOf<typeof schema.anomalies.$inferSelect>();
  expectTypeOf<Records['assistantHealthAlerts']>().toEqualTypeOf<
    typeof schema.assistantHealthAlerts.$inferSelect
  >();
  expectTypeOf<Records['skills']>().toEqualTypeOf<typeof schema.skills.$inferSelect>();
  expectTypeOf<Records['skillLibraryRevisions']>().toEqualTypeOf<
    typeof schema.skillLibraryRevisions.$inferSelect
  >();
  expectTypeOf<Records['improvementProposals']>().toEqualTypeOf<
    typeof schema.improvementProposals.$inferSelect
  >();
  expectTypeOf<Records['memories']>().toEqualTypeOf<typeof schema.memories.$inferSelect>();
  expectTypeOf<Records['memoryEmbeddingRefreshes']>().toEqualTypeOf<
    typeof schema.memoryEmbeddingRefreshes.$inferSelect
  >();
  expectTypeOf<Records['memoryTombstones']>().toEqualTypeOf<
    typeof schema.memoryTombstones.$inferSelect
  >();
  expectTypeOf<Records['ownerCard']>().toEqualTypeOf<typeof schema.ownerCard.$inferSelect>();
  expectTypeOf<Records['contacts']>().toEqualTypeOf<typeof schema.contacts.$inferSelect>();
  expectTypeOf<Records['knowledgeGraphEntities']>().toEqualTypeOf<
    typeof schema.knowledgeGraphEntities.$inferSelect
  >();
  expectTypeOf<Records['knowledgeGraphEntityAliases']>().toEqualTypeOf<
    typeof schema.knowledgeGraphEntityAliases.$inferSelect
  >();
  expectTypeOf<Records['knowledgeGraphSources']>().toEqualTypeOf<
    typeof schema.knowledgeGraphSources.$inferSelect
  >();
  expectTypeOf<Records['knowledgeGraphRelations']>().toEqualTypeOf<
    typeof schema.knowledgeGraphRelations.$inferSelect
  >();
  expectTypeOf<Records['knowledgeGraphAssertions']>().toEqualTypeOf<
    typeof schema.knowledgeGraphAssertions.$inferSelect
  >();
  expectTypeOf<Records['knowledgeGraphAssertionEvidence']>().toEqualTypeOf<
    typeof schema.knowledgeGraphAssertionEvidence.$inferSelect
  >();
  expectTypeOf<Records['occasions']>().toEqualTypeOf<typeof schema.occasions.$inferSelect>();
  expectTypeOf<Records['importSources']>().toEqualTypeOf<
    typeof schema.importSources.$inferSelect
  >();
  expectTypeOf<Records['memoryImportLineage']>().toEqualTypeOf<
    typeof schema.memoryImportLineage.$inferSelect
  >();
  expectTypeOf<Records['occasionImportLineage']>().toEqualTypeOf<
    typeof schema.occasionImportLineage.$inferSelect
  >();
  expectTypeOf<Records['models']>().toEqualTypeOf<typeof schema.models.$inferSelect>();
  expectTypeOf<Records['callSessions']>().toEqualTypeOf<typeof schema.callSessions.$inferSelect>();
  expectTypeOf<Records['modelConnections']>().toEqualTypeOf<
    typeof schema.modelConnections.$inferSelect
  >();
  expectTypeOf<Records['modelRoles']>().toEqualTypeOf<typeof schema.modelRoles.$inferSelect>();
  expectTypeOf<Records['modelRoleRevisions']>().toEqualTypeOf<
    typeof schema.modelRoleRevisions.$inferSelect
  >();
  expectTypeOf<Records['modelCalls']>().toEqualTypeOf<typeof schema.modelCalls.$inferSelect>();
  expectTypeOf<Records['costEvents']>().toEqualTypeOf<typeof schema.costEvents.$inferSelect>();
  expectTypeOf<Records['costReservations']>().toEqualTypeOf<
    typeof schema.costReservations.$inferSelect
  >();
  expectTypeOf<Records['rateTable']>().toEqualTypeOf<typeof schema.rateTable.$inferSelect>();
  expectTypeOf<Records['budgets']>().toEqualTypeOf<typeof schema.budgets.$inferSelect>();
  expectTypeOf<Records['toolCache']>().toEqualTypeOf<typeof schema.toolCache.$inferSelect>();
  expectTypeOf<Records['rateLimits']>().toEqualTypeOf<typeof schema.rateLimits.$inferSelect>();
  expectTypeOf<Records['writingSamples']>().toEqualTypeOf<
    typeof schema.writingSamples.$inferSelect
  >();
  expectTypeOf<Records['voiceProfile']>().toEqualTypeOf<typeof schema.voiceProfile.$inferSelect>();
  expectTypeOf<Records['gmailSyncState']>().toEqualTypeOf<
    typeof schema.gmailSyncState.$inferSelect
  >();
  expectTypeOf<Records['emailIngest']>().toEqualTypeOf<typeof schema.emailIngest.$inferSelect>();
  expectTypeOf<Records['suggestions']>().toEqualTypeOf<typeof schema.suggestions.$inferSelect>();
  expectTypeOf<Records['schedules']>().toEqualTypeOf<typeof schema.schedules.$inferSelect>();
  expectTypeOf<Records['watches']>().toEqualTypeOf<typeof schema.watches.$inferSelect>();
  expectTypeOf<Records['watchFires']>().toEqualTypeOf<typeof schema.watchFires.$inferSelect>();
  expectTypeOf<Records['notificationPrefs']>().toEqualTypeOf<
    typeof schema.notificationPrefs.$inferSelect
  >();
  expectTypeOf<Records['proactivePings']>().toEqualTypeOf<
    typeof schema.proactivePings.$inferSelect
  >();
  expectTypeOf<Records['proactiveMoments']>().toEqualTypeOf<
    typeof schema.proactiveMoments.$inferSelect
  >();
  expectTypeOf<Records['calendarEventSnapshots']>().toEqualTypeOf<
    typeof schema.calendarEventSnapshots.$inferSelect
  >();
  expectTypeOf<Records['canaryRuns']>().toEqualTypeOf<typeof schema.canaryRuns.$inferSelect>();
  expectTypeOf<Records['files']>().toEqualTypeOf<typeof schema.files.$inferSelect>();
  expectTypeOf<Records['documents']>().toEqualTypeOf<typeof schema.documents.$inferSelect>();
  expectTypeOf<Records['documentChunks']>().toEqualTypeOf<
    typeof schema.documentChunks.$inferSelect
  >();
  expectTypeOf<Records['locationPings']>().toEqualTypeOf<
    typeof schema.locationPings.$inferSelect
  >();
  expectTypeOf<Records['ambientSnapshots']>().toEqualTypeOf<
    typeof schema.ambientSnapshots.$inferSelect
  >();
  expectTypeOf<Records['dreamNotes']>().toEqualTypeOf<typeof schema.dreamNotes.$inferSelect>();
  expectTypeOf<Records['deviceTokens']>().toEqualTypeOf<typeof schema.deviceTokens.$inferSelect>();
  expectTypeOf<Records['selfRepairIssues']>().toEqualTypeOf<
    typeof schema.selfRepairIssues.$inferSelect
  >();
  expectTypeOf<Records['selfMaintenance']>().toEqualTypeOf<
    typeof schema.selfMaintenance.$inferSelect
  >();
  expectTypeOf<Records['responseChecks']>().toEqualTypeOf<
    typeof schema.responseChecks.$inferSelect
  >();
  expectTypeOf<Records['recallMetrics']>().toEqualTypeOf<
    typeof schema.recallMetrics.$inferSelect
  >();
  expectTypeOf<Records['recallFeedback']>().toEqualTypeOf<
    typeof schema.recallFeedback.$inferSelect
  >();
});
