import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { conversations, type Db, messages, tasks } from '@assistant/db';
import { and, eq, like } from 'drizzle-orm';
import type { VerifiedScriptTestTarget } from '../test-target.js';
import { assertAllocatedTestDatabaseOwnership } from '../test-target.js';
import {
  appendPrivateJsonLine,
  type ReadabilityRunManifest,
  readPrivateJson,
  replacePrivateJson,
} from './chat-readability-safety.js';

export async function cleanupReadabilityFixtures(input: {
  db: Db;
  artifactDirectory: string;
  target: VerifiedScriptTestTarget;
  run?: 'baseline' | 'reframed';
}): Promise<{ cleaned: number; skipped: number }> {
  await assertAllocatedTestDatabaseOwnership(input.db, input.target);
  let names: string[];
  try {
    names = await readdir(input.artifactDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cleaned: 0, skipped: 0 };
    throw error;
  }
  const manifests = names.filter((name) => name.endsWith('.manifest.json'));
  let cleaned = 0;
  let skipped = 0;
  for (const name of manifests) {
    const file = path.join(input.artifactDirectory, name);
    const manifest = await readPrivateJson<ReadabilityRunManifest>(file);
    if (input.run && manifest.run !== input.run) continue;
    if (manifest.status === 'cleaned') {
      skipped += 1;
      continue;
    }
    if (
      manifest.targetDatabaseName !== input.target.databaseName ||
      manifest.targetToken !== input.target.token
    ) {
      skipped += 1;
      continue;
    }
    if (!manifest.conversationId) {
      skipped += 1;
      continue;
    }
    const [conversation] = await input.db
      .select({
        id: conversations.id,
        agentId: conversations.agentId,
        isPrimary: conversations.isPrimary,
        metadata: conversations.metadata,
      })
      .from(conversations)
      .where(eq(conversations.id, manifest.conversationId))
      .limit(1);
    const [task] = await input.db
      .select({
        id: tasks.id,
        agentId: tasks.agentId,
        externalEventId: tasks.externalEventId,
        trigger: tasks.trigger,
      })
      .from(tasks)
      .where(eq(tasks.id, manifest.taskId))
      .limit(1);
    if (task && !isManifestTask(task, manifest)) {
      throw new Error(`refusing to clean task ${manifest.taskId}: fixture identity mismatch`);
    }
    if (!conversation) {
      if (task) {
        await input.db
          .update(tasks)
          .set({ status: 'done', archivedAt: new Date() })
          .where(eq(tasks.id, task.id));
      }
      await recordCleaned(input.artifactDirectory, file, manifest, {
        event: 'fixture_already_absent',
      });
      cleaned += 1;
      continue;
    }
    const metadata = conversation.metadata as Record<string, unknown>;
    if (
      conversation.isPrimary ||
      conversation.agentId !== manifest.agentId ||
      metadata.fixtureKind !== 'chat-readability' ||
      metadata.runId !== manifest.runId ||
      metadata.targetDatabaseName !== input.target.databaseName
    ) {
      throw new Error(
        `refusing to clean conversation ${manifest.conversationId}: fixture identity mismatch`,
      );
    }
    await input.db.transaction(async (tx) => {
      await tx
        .delete(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            like(messages.channelMessageId, `readability-${manifest.run}-${manifest.runId}-%`),
          ),
        );
      const [remainingMessage] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .limit(1);
      if (!remainingMessage) {
        await tx.delete(conversations).where(eq(conversations.id, conversation.id));
      }
      if (task) {
        // Preserve task-linked cost/model receipts, but hide the synthetic QA task.
        await tx
          .update(tasks)
          .set({ status: 'done', archivedAt: new Date() })
          .where(eq(tasks.id, task.id));
      }
    });
    await recordCleaned(input.artifactDirectory, file, manifest, {
      event: 'fixture_cleaned',
      conversationId: conversation.id,
    });
    cleaned += 1;
  }
  return { cleaned, skipped };
}

function isManifestTask(
  task: { agentId: string; externalEventId: string | null; trigger: unknown },
  manifest: ReadabilityRunManifest,
): boolean {
  const trigger = task.trigger as Record<string, unknown> | undefined;
  return (
    task.agentId === manifest.agentId &&
    task.externalEventId === `visual-qa:chat-readability:${manifest.runId}` &&
    trigger?.fixtureKind === 'chat-readability' &&
    trigger.runId === manifest.runId
  );
}

async function recordCleaned(
  artifactDirectory: string,
  manifestFile: string,
  manifest: ReadabilityRunManifest,
  event: Record<string, unknown>,
): Promise<void> {
  await appendPrivateJsonLine(
    path.join(artifactDirectory, `${manifest.run}-${manifest.runId}.jsonl`),
    { at: new Date().toISOString(), runId: manifest.runId, ...event },
  );
  manifest.status = 'cleaned';
  await replacePrivateJson(manifestFile, manifest);
}
