import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorized: vi.fn(),
  effect: vi.fn(() => {
    throw new Error('mutation dependency accessed before validation');
  }),
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.authorized,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/lib/approval-store', () => ({ withApprovalDecisionStore: mocks.effect }));
vi.mock('@/lib/firestore-knowledge', () => ({
  getFirestoreKnowledgeCuration: mocks.effect,
  getFirestoreKnowledgeWorkspace: mocks.effect,
}));
vi.mock('@/lib/firestore-profile-commands', () => ({
  deleteFirestorePerson: mocks.effect,
  getFirestoreProfileCommands: mocks.effect,
  mergeFirestorePeople: mocks.effect,
  recompileFirestoreProfileCard: mocks.effect,
}));
vi.mock('@/lib/firestore-settings-mutation', () => ({
  runFirestoreSettingsMutation: mocks.effect,
}));
vi.mock('@/lib/memory-erasure', () => ({ forgetOwnerLongTermMemory: mocks.effect }));
vi.mock('@/lib/mobile-card-capabilities', () => ({ projectMobileCardCapabilities: mocks.effect }));
vi.mock('@/lib/mobile-skill-write', () => ({ writeFirestoreMobileSkill: mocks.effect }));
vi.mock('@/lib/proposal-code-fix', () => ({
  proposalCodeFixReceipt: mocks.effect,
  requestOwnerProposalCodeFix: mocks.effect,
}));
vi.mock('@/lib/self-repair-server', () => ({
  decideOwnerRepair: mocks.effect,
  getSelfRepairOverview: mocks.effect,
  reportOwnerRepair: mocks.effect,
}));
vi.mock('@/lib/server', () => ({
  addOwnerKnowledgeGraphFactForCurrentPersistence: mocks.effect,
  correctOwnerKnowledgeGraphFactForCurrentPersistence: mocks.effect,
  discoverFirestoreMcpConnection: mocks.effect,
  encryptMcpConnectionBearerToken: mocks.effect,
  getAgentIdentity: mocks.effect,
  getApplication: mocks.effect,
  getCallsPorts: mocks.effect,
  getCardRefresh: mocks.effect,
  getChatApplication: mocks.effect,
  getDb: mocks.effect,
  getEmailObligationRepository: mocks.effect,
  getFirestoreInstallationStore: mocks.effect,
  getGeneratedCards: mocks.effect,
  getImportCommands: mocks.effect,
  getOwnerMemoryCommands: mocks.effect,
  getWorkspace: mocks.effect,
  organizeOwnerMemoryNow: mocks.effect,
  recordOwnerLocation: mocks.effect,
  registerOwnerDeviceToken: mocks.effect,
}));
vi.mock('@/lib/task-activity', () => ({ discoverTaskActivity: mocks.effect }));
vi.mock('@/lib/workspace-reviews', () => ({
  decideOwnerImprovement: mocks.effect,
  dismissOwnerAnomaly: mocks.effect,
  suspendOwnerAnomalyPolicy: mocks.effect,
}));
vi.mock('@assistant/application', () => ({
  GRAPH_EXTRACTION_VERSION: mocks.effect,
  asGraphEntityKind: mocks.effect,
  cleanKnowledgeProjectionOrphans: mocks.effect,
  getKnowledgeCleanupFindings: mocks.effect,
  getKnowledgeGraphOverview: mocks.effect,
  getKnowledgeGraphRelation: mocks.effect,
  getKnowledgeGraphReviewQueue: mocks.effect,
  getKnowledgeSourceImpact: mocks.effect,
  mergeKnowledgeGraphEntities: mocks.effect,
  presentKnowledgeGraphRelation: mocks.effect,
  renameKnowledgeGraphEntity: mocks.effect,
  retryQuarantinedKnowledgeGraphSources: mocks.effect,
  retypeKnowledgeGraphEntity: mocks.effect,
  reviewKnowledgeGraphRelation: mocks.effect,
  searchKnowledgeGraphEntities: mocks.effect,
}));
vi.mock('@assistant/application/approvals', () => ({
  approveAndRememberApproval: mocks.effect,
  decideApproval: mocks.effect,
}));
vi.mock('@assistant/application/calls', () => ({
  answerCallCheckin: mocks.effect,
  getCall: mocks.effect,
  hangUpCall: mocks.effect,
}));
vi.mock('@assistant/application/cards', () => ({
  dismissSavedCard: mocks.effect,
  requestSavedCardRefresh: mocks.effect,
}));
vi.mock('@assistant/application/email-obligations', () => ({
  decideOwnerEmailObligation: mocks.effect,
  listOwnerEmailObligations: mocks.effect,
}));
vi.mock('@assistant/application/profile', () => ({
  addPersonOccasion: mocks.effect,
  createPerson: mocks.effect,
  deletePerson: mocks.effect,
  forgetPersonOccasion: mocks.effect,
  getPersonProfile: mocks.effect,
  getVoiceOverview: mocks.effect,
  mergePeople: mocks.effect,
  purgeProfileVoiceSamples: mocks.effect,
  recompileProfileCard: mocks.effect,
  reviewPersonOccasion: mocks.effect,
  updatePersonIdentity: mocks.effect,
  updatePersonOccasion: mocks.effect,
  updatePersonRelationship: mocks.effect,
  updateVoiceProfile: mocks.effect,
}));
vi.mock('@assistant/application/settings', () => ({ createSettingsFacade: mocks.effect }));
vi.mock('@assistant/application/suggestions', () => ({
  decideSuggestion: mocks.effect,
  snoozeSuggestionUntil: mocks.effect,
}));
vi.mock('@assistant/application/tasks', () => ({
  archiveActivity: mocks.effect,
  archiveActivityWithRepository: mocks.effect,
  archiveOldActivity: mocks.effect,
  archiveOldActivityWithRepository: mocks.effect,
  cancelActivity: mocks.effect,
  cancelActivityWithRepository: mocks.effect,
  raiseTaskBudget: mocks.effect,
  raiseTaskBudgetWithRepository: mocks.effect,
  restoreActivity: mocks.effect,
  restoreActivityWithRepository: mocks.effect,
  retryActivity: mocks.effect,
  retryActivityWithRepository: mocks.effect,
  revokeTaskAutonomy: mocks.effect,
  revokeTaskAutonomyWithRepository: mocks.effect,
}));
vi.mock('@assistant/application/workspace-skills', () => ({
  deleteMobileSkill: mocks.effect,
  setMobileSkillDeprecated: mocks.effect,
}));
vi.mock('@assistant/config', () => ({
  loadConfig: mocks.effect,
  parseFirestoreEmbeddingSpace: mocks.effect,
  validateAgentPersistenceConfig: mocks.effect,
}));
vi.mock('@assistant/firestore', () => ({
  FirestoreCommitmentMutationRepository: mocks.effect,
  FirestoreKnowledgeGraphRelationMutationRepository: mocks.effect,
  FirestoreMcpConnectionMutationRepository: mocks.effect,
  FirestoreMcpConnectionReadRepository: mocks.effect,
  FirestoreOwnerCardCompilationRepository: mocks.effect,
  FirestoreProfileOccasionCommandRepository: mocks.effect,
  FirestoreProfilePeopleReadRepository: mocks.effect,
  FirestoreProfileVoiceOverviewRepository: mocks.effect,
  FirestoreSkillMutationRepository: mocks.effect,
  FirestoreSuggestionDecisionRepository: mocks.effect,
  FirestoreTaskActivityCommandRepository: mocks.effect,
  FirestoreVoiceProfileRepository: mocks.effect,
  FirestoreVoiceSamplePurgeRepository: mocks.effect,
  assertPrivacyErasureFenceUnchanged: mocks.effect,
  createFirestoreSettingsPersistence: mocks.effect,
  createInstallationStore: mocks.effect,
  getFirestoreCommitmentOverview: mocks.effect,
  getFirestoreKnowledgeGraphOverview: mocks.effect,
  getFirestoreKnowledgeGraphRelation: mocks.effect,
  getFirestoreKnowledgeGraphReviewQueue: mocks.effect,
  readPrivacyErasureFence: mocks.effect,
}));
vi.mock('@assistant/persistence', () => ({ TaskDiscoveryInputError: mocks.effect }));

import { POST as endpoint0 } from '../app/api/mobile/v1/activity/[id]/route';
import { POST as endpoint1 } from '../app/api/mobile/v1/activity/route';
import { POST as endpoint2 } from '../app/api/mobile/v1/anomalies/[id]/route';
import { POST as endpoint3 } from '../app/api/mobile/v1/approvals/[id]/route';
import { POST as endpoint4 } from '../app/api/mobile/v1/calls/[id]/route';
import { POST as endpoint5 } from '../app/api/mobile/v1/cards/[id]/route';
import { POST as endpoint6 } from '../app/api/mobile/v1/chats/[id]/messages/[messageId]/route';
import { POST as endpoint7 } from '../app/api/mobile/v1/chats/[id]/route';
import { POST as endpoint8 } from '../app/api/mobile/v1/chats/route';
import { POST as endpoint9 } from '../app/api/mobile/v1/devices/route';
import { POST as endpoint10 } from '../app/api/mobile/v1/email-obligations/route';
import { POST as endpoint11 } from '../app/api/mobile/v1/imports/route';
import { POST as endpoint12 } from '../app/api/mobile/v1/improvements/[id]/route';
import { PATCH as endpoint13 } from '../app/api/mobile/v1/knowledge/[id]/route';
import { POST as endpoint14 } from '../app/api/mobile/v1/knowledge/cleanup/route';
import { POST as endpoint15 } from '../app/api/mobile/v1/knowledge/relations/[id]/route';
import { POST as endpoint16 } from '../app/api/mobile/v1/knowledge/route';
import { PATCH as endpoint17 } from '../app/api/mobile/v1/knowledge/sources/[id]/route';
import { POST as endpoint18 } from '../app/api/mobile/v1/location/route';
import { POST as endpoint19 } from '../app/api/mobile/v1/mcp/[id]/route';
import { POST as endpoint20 } from '../app/api/mobile/v1/mcp/route';
import { PATCH as endpoint21, POST as endpoint22 } from '../app/api/mobile/v1/memory/[id]/route';
import { POST as endpoint23 } from '../app/api/mobile/v1/memory/commitments/route';
import {
  POST as endpoint24,
  PATCH as endpoint25,
} from '../app/api/mobile/v1/memory/occasions/[id]/route';
import { POST as endpoint26 } from '../app/api/mobile/v1/memory/people/[id]/occasions/route';
import {
  PATCH as endpoint27,
  POST as endpoint28,
} from '../app/api/mobile/v1/memory/people/[id]/route';
import { POST as endpoint29 } from '../app/api/mobile/v1/memory/people/route';
import { POST as endpoint30 } from '../app/api/mobile/v1/memory/profile/route';
import { POST as endpoint31 } from '../app/api/mobile/v1/memory/route';
import { POST as endpoint32 } from '../app/api/mobile/v1/repairs/[id]/route';
import { POST as endpoint33 } from '../app/api/mobile/v1/repairs/route';
import { POST as endpoint34 } from '../app/api/mobile/v1/settings/policies/[id]/route';
import { PATCH as endpoint35 } from '../app/api/mobile/v1/settings/route';
import { POST as endpoint36 } from '../app/api/mobile/v1/settings/schedules/[id]/route';
import { PATCH as endpoint37, POST as endpoint38 } from '../app/api/mobile/v1/skills/[id]/route';
import { POST as endpoint39 } from '../app/api/mobile/v1/skills/route';
import { POST as endpoint40 } from '../app/api/mobile/v1/suggestions/[id]/route';

const endpoints = [
  { name: 'activity/[id] POST', invoke: endpoint0 },
  { name: 'activity POST', invoke: endpoint1 },
  { name: 'anomalies/[id] POST', invoke: endpoint2 },
  { name: 'approvals/[id] POST', invoke: endpoint3 },
  { name: 'calls/[id] POST', invoke: endpoint4 },
  { name: 'cards/[id] POST', invoke: endpoint5 },
  { name: 'chats/[id]/messages/[messageId] POST', invoke: endpoint6 },
  { name: 'chats/[id] POST', invoke: endpoint7 },
  { name: 'chats POST', invoke: endpoint8 },
  { name: 'devices POST', invoke: endpoint9 },
  { name: 'email-obligations POST', invoke: endpoint10 },
  { name: 'imports POST', invoke: endpoint11 },
  { name: 'improvements/[id] POST', invoke: endpoint12 },
  { name: 'knowledge/[id] PATCH', invoke: endpoint13 },
  { name: 'knowledge/cleanup POST', invoke: endpoint14 },
  { name: 'knowledge/relations/[id] POST', invoke: endpoint15 },
  { name: 'knowledge POST', invoke: endpoint16 },
  { name: 'knowledge/sources/[id] PATCH', invoke: endpoint17 },
  { name: 'location POST', invoke: endpoint18 },
  { name: 'mcp/[id] POST', invoke: endpoint19 },
  { name: 'mcp POST', invoke: endpoint20 },
  { name: 'memory/[id] PATCH', invoke: endpoint21 },
  { name: 'memory/[id] POST', invoke: endpoint22 },
  { name: 'memory/commitments POST', invoke: endpoint23 },
  { name: 'memory/occasions/[id] POST', invoke: endpoint24 },
  { name: 'memory/occasions/[id] PATCH', invoke: endpoint25 },
  { name: 'memory/people/[id]/occasions POST', invoke: endpoint26 },
  { name: 'memory/people/[id] PATCH', invoke: endpoint27 },
  { name: 'memory/people/[id] POST', invoke: endpoint28 },
  { name: 'memory/people POST', invoke: endpoint29 },
  { name: 'memory/profile POST', invoke: endpoint30 },
  { name: 'memory POST', invoke: endpoint31 },
  { name: 'repairs/[id] POST', invoke: endpoint32 },
  { name: 'repairs POST', invoke: endpoint33 },
  { name: 'settings/policies/[id] POST', invoke: endpoint34 },
  { name: 'settings PATCH', invoke: endpoint35 },
  { name: 'settings/schedules/[id] POST', invoke: endpoint36 },
  { name: 'skills/[id] PATCH', invoke: endpoint37 },
  { name: 'skills/[id] POST', invoke: endpoint38 },
  { name: 'skills POST', invoke: endpoint39 },
  { name: 'suggestions/[id] POST', invoke: endpoint40 },
];
const context = {
  params: Promise.resolve({
    id: '11111111-1111-4111-8111-111111111111',
    messageId: '22222222-2222-4222-8222-222222222222',
  }),
};
function request(body: BodyInit, extraHeaders: Record<string, string> = {}) {
  return new Request('https://assistant.invalid/api/mobile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body,
  });
}
describe.each(endpoints)('$name bounded owner mutation', ({ invoke }) => {
  it.each([
    { label: 'malformed JSON', body: '{', status: 400 },
    { label: 'unknown key', body: '{"unrecognizedOwnerMutation":true}', status: 400 },
    { label: 'array', body: '[]', status: 400 },
    { label: 'null', body: 'null', status: 400 },
    { label: 'invalid UTF-8', body: new Uint8Array([0xff]), status: 400 },
    { label: 'streamed oversize', body: ' '.repeat(65537), status: 413 },
    { label: 'declared oversize', body: '{}', status: 413, headers: { 'content-length': '65537' } },
  ])('rejects $label before any dependency access', async ({ body, status, headers }) => {
    mocks.authorized.mockResolvedValue(true);
    mocks.effect.mockClear();
    expect((await invoke(request(body, headers), context)).status).toBe(status);
    expect(mocks.effect).not.toHaveBeenCalled();
  });
  it('authenticates before reading or accessing dependencies', async () => {
    mocks.authorized.mockResolvedValue(false);
    mocks.effect.mockClear();
    const input = request('{');
    expect((await invoke(input, context)).status).toBe(401);
    expect(input.bodyUsed).toBe(false);
    expect(mocks.effect).not.toHaveBeenCalled();
  });
});
