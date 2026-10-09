import { loadConfig } from '@assistant/config';
import { createDb, schedules } from '@assistant/db';
import { eq } from 'drizzle-orm';
import { morningBriefRecoveryReport } from '../packages/db/src/schedule-retirement-report.js';

const db = createDb(loadConfig().DATABASE_URL);
try {
  const rows = await db.select().from(schedules).where(eq(schedules.name, 'morning-brief'));
  console.log(JSON.stringify(morningBriefRecoveryReport(rows), null, 2));
} catch {
  console.error('Could not read morning-brief retirement state. No changes were made.');
  process.exitCode = 1;
} finally {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
}
