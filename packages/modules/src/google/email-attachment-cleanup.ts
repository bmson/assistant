import type { EmailAttachmentCustodyRepository } from '@assistant/persistence';
import type { EmailAttachmentCustodyStore } from '@assistant/tools';

/** Remove only exact, UUID-owned generations represented by durable cleanup intents. */
export async function sweepEmailAttachmentCustodyCleanup(
  repository: EmailAttachmentCustodyRepository | undefined,
  workspace: EmailAttachmentCustodyStore | undefined,
  agentId: string,
): Promise<number> {
  if (!repository || !workspace || !agentId) return 0;
  const page = await repository.listEmailAttachmentCustodyCleanup({
    agentId,
    cursor: null,
    limit: 50,
  });
  let completed = 0;
  for (const { custody, asset } of page.items) {
    const expectedGeneration = asset.generation;
    if (!expectedGeneration) continue;
    const object = await workspace.inspectEmailAttachmentObject(custody.id, expectedGeneration);
    if (!object) {
      if (
        await repository.markEmailAttachmentCustodyErased({
          agentId,
          custodyId: custody.id,
          deletedGeneration: expectedGeneration,
        })
      )
        completed += 1;
      continue;
    }
    if (object.custodyId !== custody.id) continue;
    const expectedState = asset.objectState;
    if (object.generation !== expectedGeneration || object.state !== expectedState) {
      await recordObservedGeneration(repository, agentId, custody.id, object);
      continue;
    }
    const result = await workspace.deleteOwnedEmailAttachment({
      custodyId: custody.id,
      expectedGeneration,
      ...(object.state === 'content' && object.sha256 ? { expectedSha256: object.sha256 } : {}),
    });
    if (result === 'deleted' || result === 'missing') {
      if (
        await repository.markEmailAttachmentCustodyErased({
          agentId,
          custodyId: custody.id,
          deletedGeneration: expectedGeneration,
        })
      )
        completed += 1;
    } else {
      const after = await workspace.inspectEmailAttachmentObject(custody.id);
      if (after && after.custodyId === custody.id)
        await recordObservedGeneration(repository, agentId, custody.id, after);
    }
  }
  return completed;
}

async function recordObservedGeneration(
  repository: EmailAttachmentCustodyRepository,
  agentId: string,
  custodyId: string,
  object: NonNullable<
    Awaited<ReturnType<EmailAttachmentCustodyStore['inspectEmailAttachmentObject']>>
  >,
) {
  if (object.state === 'marker') {
    await repository.recordEmailAttachmentMarker({
      agentId,
      custodyId,
      generation: object.generation,
    });
  } else {
    await repository.recordEmailAttachmentObject({
      agentId,
      custodyId,
      generation: object.generation,
    });
  }
}
