import { afterAll, describe } from 'vitest';
import { signalContract } from '../../persistence/src/signal-test-scenarios.js';
import { createDb } from './client.js';
import { agents, emailIngest } from './schema.js';
import { createPostgresSignalRepository } from './signals.js';

describe('PostgreSQL producer signal contract', () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Run through the disposable database test wrapper');
  const db = createDb(databaseUrl);
  afterAll(() => db.$client.end());

  signalContract(async () => ({
    repository: createPostgresSignalRepository(db),
    async seedOwner(agentId) {
      await db.insert(agents).values({
        id: agentId,
        name: 'Fixture owner',
        email: `${agentId}@example.test`,
        workspacePrefix: agentId,
      });
    },
    async seedSource(row) {
      await db.insert(emailIngest).values(row);
    },
  }));
});
