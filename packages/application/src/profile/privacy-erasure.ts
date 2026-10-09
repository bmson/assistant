import type { PrivacyErasureAsset, PrivacyErasureRepository } from '@assistant/persistence';

export interface PrivacyWorkspace {
  delete(relativePath: string): Promise<void>;
  readonly emailAttachmentCustody?: {
    inspectEmailAttachmentObject(
      custodyId: string,
      generation?: string,
    ): Promise<{
      generation: string;
      custodyId: string;
      state: 'marker' | 'content';
      sha256: string | null;
    } | null>;
    deleteOwnedEmailAttachment(input: {
      custodyId: string;
      expectedGeneration?: string;
      expectedSha256?: string;
    }): Promise<'deleted' | 'missing' | 'changed'>;
  };
}

/** Complete the durable data phase, then acknowledge each successfully removed asset. */
export async function forgetLongTermMemoryWithRepository(
  repository: PrivacyErasureRepository,
  workspace?: PrivacyWorkspace,
) {
  const counts = await repository.erase();
  for (;;) {
    const assets = await repository.pendingAssets();
    if (!assets.length) break;
    if (!workspace) throw new Error('Workspace is required to finish memory erasure');
    for (const asset of assets) {
      if (asset.kind === 'email_attachment_custody') {
        const custody = workspace.emailAttachmentCustody;
        if (!custody) throw new Error('Email attachment custody cleanup is unsupported');
        const result = await custody.deleteOwnedEmailAttachment({
          custodyId: asset.custodyId,
          expectedGeneration: asset.generation,
        });
        if (result === 'changed') {
          const observed = await custody.inspectEmailAttachmentObject(
            asset.custodyId,
            asset.generation,
          );
          if (!observed)
            throw new Error('Exact email attachment generation could not be confirmed');
          if (observed.custodyId !== asset.custodyId)
            throw new Error('Email attachment custody identity changed during cleanup');
          if (observed.generation !== asset.generation || observed.state !== asset.objectState) {
            await repository.refreshEmailAttachmentCustodyCleanupIntent(asset, {
              generation: observed.generation,
              objectState: observed.state,
            });
          }
          continue;
        }
        if (result !== 'deleted' && result !== 'missing')
          throw new Error('Email attachment custody cleanup did not confirm deletion');
        await repository.assetDeleted(asset);
      } else {
        await workspace.delete(asset.workspacePath);
        await repository.assetDeleted(asset as PrivacyErasureAsset);
      }
    }
  }
  await repository.complete();
  return counts;
}
