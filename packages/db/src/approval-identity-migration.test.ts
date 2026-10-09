import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../drizzle/0084_approval_identity_reconciliation.sql', import.meta.url),
  'utf8',
);

describe('forward approval identity correction', () => {
  it.each(['missing', 'wrong-definition', 'correct'] as const)(
    'repairs %s schema while retaining linked approval history and is retryable',
    async (state) => {
      const url = process.env.DATABASE_URL;
      if (!url || !new URL(url).pathname.endsWith('_test'))
        throw new Error('Requires disposable database');
      const client = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await client.begin(async (tx) => {
          await tx`CREATE TEMP TABLE approval_policies (id uuid PRIMARY KEY, agent_id uuid NOT NULL, tool_name text NOT NULL, template_key text NOT NULL, match jsonb NOT NULL, effect text NOT NULL, enabled boolean NOT NULL, created_at timestamptz NOT NULL)`;
          await tx`CREATE TEMP TABLE approvals (id uuid PRIMARY KEY, created_policy_id uuid REFERENCES approval_policies(id))`;
          await tx`SET LOCAL search_path TO pg_temp, public`;
          if (state === 'wrong-definition')
            await tx`CREATE INDEX approval_policies_identity_idx ON approval_policies(tool_name)`;
          if (state === 'correct')
            await tx`CREATE UNIQUE INDEX approval_policies_identity_idx ON approval_policies(agent_id,tool_name,template_key,match,effect)`;
          const agent = randomUUID(),
            retained = randomUUID(),
            duplicate = randomUUID(),
            approval = randomUUID();
          await tx`INSERT INTO approval_policies VALUES (${retained}, ${agent}, 'gmail.send', 'recipient', '{"recipient":"synthetic@example.test"}', 'allow', true, '2026-01-01')`;
          if (state !== 'correct') {
            await tx`INSERT INTO approval_policies VALUES (${duplicate}, ${agent}, 'gmail.send', 'recipient', '{"recipient":"synthetic@example.test"}', 'allow', false, '2025-01-01')`;
            await tx`INSERT INTO approvals VALUES (${approval}, ${duplicate})`;
          } else await tx`INSERT INTO approvals VALUES (${approval}, ${retained})`;
          await tx.unsafe(migration);
          await tx.unsafe(migration);
          expect(await tx`SELECT id FROM approval_policies`).toHaveLength(1);
          expect((await tx`SELECT created_policy_id FROM approvals`)[0]?.created_policy_id).toBe(
            retained,
          );
          // This is the same conflict target approve-and-remember requires.
          await tx`INSERT INTO approval_policies VALUES (${randomUUID()}, ${agent}, 'gmail.send', 'recipient', '{"recipient":"synthetic@example.test"}', 'allow', true, now()) ON CONFLICT (agent_id,tool_name,template_key,match,effect) DO UPDATE SET enabled = true`;
          expect(await tx`SELECT id FROM approval_policies`).toHaveLength(1);
        });
      } finally {
        await client.end();
      }
    },
  );
});
