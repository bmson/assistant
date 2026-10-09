import { listApprovalInbox } from '@assistant/application/approvals';
import { listGoalsDashboardWithRepository } from '@assistant/application/goals';
import { listActivityWithRepository } from '@assistant/application/tasks';
import { isModuleEnabled, loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreApprovalRepository,
  FirestoreGoalReadRepository,
  FirestoreTaskActivityRepository,
} from '@assistant/firestore';
import { mobilePageMetadata } from '@/lib/mobile-document-pages';
import {
  getApplication,
  getFirestoreInstallationStore,
  getMobileDocumentsPage,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Owner-facing secondary surfaces used by the native tab bar. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const store = getFirestoreInstallationStore();
    try {
      // Each refresh starts its own read: an older in-flight snapshot cannot cross an owner mutation.
      const overview = await (async () => {
        const [activity, goals, approvals, documents] = await Promise.all([
          listActivityWithRepository(
            new FirestoreTaskActivityRepository(store),
            config.FIRESTORE_AGENT_ID,
            {
              archived: false,
              filter: 'all',
              limit: 50,
            },
          ),
          listGoalsDashboardWithRepository(
            new FirestoreGoalReadRepository(store, config.FIRESTORE_AGENT_ID),
            config.FIRESTORE_AGENT_ID,
            false,
          ),
          listApprovalInbox(
            {
              agentId: config.FIRESTORE_AGENT_ID,
              approvals: new FirestoreApprovalRepository(store),
            },
            20,
          ),
          isModuleEnabled(config, 'documents')
            ? getMobileDocumentsPage({ limit: 50, cursor: null }).then((result) => ({
                ...result,
                pagination: mobilePageMetadata({
                  limit: 50,
                  hasMore: result.hasMore,
                  nextCursor: result.nextCursor,
                }),
              }))
            : Promise.resolve({
                documents: [],
                stats: { total: 0, ready: 0, pending: 0, chunks: 0 },
                primaryConversationId: null,
                hasMore: false,
                nextCursor: null,
                pagination: mobilePageMetadata({ limit: 50, hasMore: false, nextCursor: null }),
              }),
        ]);
        return { generatedAt: new Date().toISOString(), activity, goals, approvals, documents };
      })();
      return mobileJson(overview);
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'Mobile overview is unavailable.' },
        { status: 503 },
      );
    }
  }
  const application = getApplication();
  const [activity, goals, approvals, documents] = await Promise.all([
    application.listActivity({ archived: false, filter: 'all', limit: 50 }),
    application.listGoals(false),
    application.listApprovals(),
    (async () => {
      if (!isModuleEnabled(config, 'documents'))
        return {
          documents: [],
          stats: { total: 0, ready: 0, pending: 0, chunks: 0 },
          primaryConversationId: null,
          hasMore: false,
          nextCursor: null,
          pagination: mobilePageMetadata({ limit: 50, hasMore: false, nextCursor: null }),
        };
      const result = await getMobileDocumentsPage({ limit: 50, cursor: null });
      return {
        ...result,
        pagination: mobilePageMetadata({
          limit: 50,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        }),
      };
    })(),
  ]);
  return mobileJson({
    generatedAt: new Date().toISOString(),
    activity,
    goals,
    approvals,
    documents,
  });
}
