import type { PrivacyErasureRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { forgetLongTermMemoryWithRepository } from './privacy-erasure.js';

describe('portable long-term memory erasure', () => {
  it('keeps workspace cleanup pending across an interruption', async () => {
    const assets = [
      { kind: 'workspace_path' as const, id: 'source', workspacePath: 'import/voice.txt' },
    ];
    const sourceAsset = assets[0];
    const erase = vi.fn(async () => ({
      memories: 1,
      graphRelations: 2,
      writingSamples: 3,
      securityIncidents: 4,
    }));
    const complete = vi.fn(async () => {});
    const assetDeleted = vi.fn(async (value: (typeof assets)[number]) => {
      const index = assets.findIndex((asset) => asset.id === value.id);
      if (index >= 0) assets.splice(index, 1);
    });
    const repository: PrivacyErasureRepository = {
      kind: 'privacy-erasure-repository',
      erase,
      pendingAssets: async () => [...assets],
      assetDeleted,
      refreshEmailAttachmentCustodyCleanupIntent: async () => {},
      complete,
    };
    const workspace = {
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error('storage unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    await expect(forgetLongTermMemoryWithRepository(repository, workspace)).rejects.toThrow(
      'storage unavailable',
    );
    expect(assets).toHaveLength(1);
    expect(assetDeleted).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    await expect(forgetLongTermMemoryWithRepository(repository, workspace)).resolves.toEqual({
      memories: 1,
      graphRelations: 2,
      writingSamples: 3,
      securityIncidents: 4,
    });
    expect(assets).toHaveLength(0);
    expect(assetDeleted).toHaveBeenCalledWith(sourceAsset);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(erase).toHaveBeenCalledTimes(2);
  });

  it('refuses to report completion without a workspace for pending assets', async () => {
    const repository: PrivacyErasureRepository = {
      kind: 'privacy-erasure-repository',
      erase: async () => ({
        memories: 0,
        graphRelations: 0,
        writingSamples: 0,
        securityIncidents: 0,
      }),
      pendingAssets: async () => [
        { kind: 'workspace_path', id: 'source', workspacePath: 'import/voice.txt' },
      ],
      assetDeleted: async () => {},
      refreshEmailAttachmentCustodyCleanupIntent: async () => {},
      complete: vi.fn(async () => {}),
    };
    await expect(forgetLongTermMemoryWithRepository(repository)).rejects.toThrow(
      'Workspace is required',
    );
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it('deletes an email attachment only through its exact custody generation', async () => {
    const asset = {
      kind: 'email_attachment_custody' as const,
      id: 'email-attachment-custody:opaque',
      workspacePath: 'email-attachments/custody/00000000-0000-4000-8000-000000000001',
      custodyId: '00000000-0000-4000-8000-000000000001',
      generation: 'generation-7',
      objectState: 'content' as const,
    };
    let pending = true;
    const repository: PrivacyErasureRepository = {
      kind: 'privacy-erasure-repository',
      erase: async () => ({
        memories: 0,
        graphRelations: 0,
        writingSamples: 0,
        securityIncidents: 0,
      }),
      pendingAssets: async () => (pending ? [asset] : []),
      assetDeleted: vi.fn(async (deleted) => {
        expect(deleted).toEqual(asset);
        pending = false;
      }),
      refreshEmailAttachmentCustodyCleanupIntent: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
    };
    const deleteOwnedEmailAttachment = vi.fn(
      async (input: { custodyId: string; expectedGeneration?: string }) => {
        expect(input).toEqual({ custodyId: asset.custodyId, expectedGeneration: asset.generation });
        return 'deleted' as const;
      },
    );
    const workspace = {
      delete: vi.fn(async () => {}),
      emailAttachmentCustody: {
        deleteOwnedEmailAttachment,
        inspectEmailAttachmentObject: vi.fn(async () => null),
      },
    };
    await expect(forgetLongTermMemoryWithRepository(repository, workspace)).resolves.toMatchObject({
      memories: 0,
    });
    expect(deleteOwnedEmailAttachment).toHaveBeenCalledTimes(1);
    expect(workspace.delete).not.toHaveBeenCalled();
    expect(repository.assetDeleted).toHaveBeenCalledWith(asset);
    expect(repository.complete).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale generation intent only after matching custody metadata is inspected', async () => {
    const stale = {
      kind: 'email_attachment_custody' as const,
      id: 'old-generation-intent',
      workspacePath: 'email-attachments/custody/00000000-0000-4000-8000-000000000002',
      custodyId: '00000000-0000-4000-8000-000000000002',
      generation: 'old-generation',
      objectState: 'marker' as const,
    };
    let pending = true;
    const repository: PrivacyErasureRepository = {
      kind: 'privacy-erasure-repository',
      erase: async () => ({
        memories: 0,
        graphRelations: 0,
        writingSamples: 0,
        securityIncidents: 0,
      }),
      pendingAssets: async () => (pending ? [stale] : []),
      assetDeleted: vi.fn(async () => {
        throw new Error('stale intent must not be acknowledged');
      }),
      refreshEmailAttachmentCustodyCleanupIntent: vi.fn(async (asset, observed) => {
        expect(asset).toEqual(stale);
        expect(observed).toEqual({ generation: 'new-generation', objectState: 'content' });
        pending = false;
      }),
      complete: vi.fn(async () => {}),
    };
    const workspace = {
      delete: vi.fn(async () => {}),
      emailAttachmentCustody: {
        deleteOwnedEmailAttachment: vi.fn(async () => 'changed' as const),
        inspectEmailAttachmentObject: vi.fn(async (custodyId: string) => ({
          custodyId,
          generation: 'new-generation',
          state: 'content' as const,
          sha256: 'b'.repeat(64),
        })),
      },
    };
    await expect(forgetLongTermMemoryWithRepository(repository, workspace)).resolves.toMatchObject({
      memories: 0,
    });
    expect(repository.refreshEmailAttachmentCustodyCleanupIntent).toHaveBeenCalledTimes(1);
    expect(repository.assetDeleted).not.toHaveBeenCalled();
    expect(workspace.delete).not.toHaveBeenCalled();
  });

  it('keeps an exact cleanup intent when changed and exact-generation inspection cannot confirm it', async () => {
    const asset = {
      kind: 'email_attachment_custody' as const,
      id: 'email-attachment-custody:opaque',
      workspacePath: 'email-attachments/custody/00000000-0000-4000-8000-000000000003',
      custodyId: '00000000-0000-4000-8000-000000000003',
      generation: 'generation-9',
      objectState: 'marker' as const,
    };
    const assetDeleted = vi.fn(async () => {});
    const complete = vi.fn(async () => {});
    const repository: PrivacyErasureRepository = {
      kind: 'privacy-erasure-repository',
      erase: async () => ({
        memories: 0,
        graphRelations: 0,
        writingSamples: 0,
        securityIncidents: 0,
      }),
      pendingAssets: async () => [asset],
      assetDeleted,
      refreshEmailAttachmentCustodyCleanupIntent: vi.fn(async () => {}),
      complete,
    };
    const inspectEmailAttachmentObject = vi.fn(async (_custodyId: string, generation?: string) => {
      expect(generation).toBe(asset.generation);
      return null;
    });
    const workspace = {
      delete: vi.fn(async () => {}),
      emailAttachmentCustody: {
        deleteOwnedEmailAttachment: vi.fn(async () => 'changed' as const),
        inspectEmailAttachmentObject,
      },
    };

    await expect(forgetLongTermMemoryWithRepository(repository, workspace)).rejects.toThrow(
      'Exact email attachment generation could not be confirmed',
    );
    expect(assetDeleted).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(workspace.delete).not.toHaveBeenCalled();
    expect(inspectEmailAttachmentObject).toHaveBeenCalledTimes(1);
  });
});
