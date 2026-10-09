import { loadConfig } from '@assistant/config';
import { createDb, modelRoleRevisions } from '@assistant/db';
import { asc, eq } from 'drizzle-orm';
import { modelRoutingReviewReport } from '../packages/db/src/model-routing-review.js';

const db = createDb(loadConfig().DATABASE_URL);
try {
  const revisions = await db
    .select()
    .from(modelRoleRevisions)
    .where(eq(modelRoleRevisions.requiresOwnerReview, true))
    .orderBy(asc(modelRoleRevisions.createdAt), asc(modelRoleRevisions.id));
  console.log(JSON.stringify(modelRoutingReviewReport(revisions), null, 2));
} catch {
  console.error('Could not read model routing review state. No changes were made.');
  process.exitCode = 1;
} finally {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
}
