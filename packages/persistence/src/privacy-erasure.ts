export interface PrivacyErasureCounts {
  memories: number;
  graphRelations: number;
  writingSamples: number;
  securityIncidents: number;
}

export type PrivacyErasureAsset =
  | {
      kind: 'workspace_path';
      id: string;
      workspacePath: string;
    }
  | {
      kind: 'email_attachment_custody';
      /** Opaque ID for this exact custody generation cleanup intent. */
      id: string;
      workspacePath: string;
      custodyId: string;
      /** Set only for an intent created by deleting this catalog document. */
      documentId?: string;
      generation: string;
      objectState: 'marker' | 'content';
    };

/* Legacy rows without `kind` are treated as workspace_path by adapters. */
export interface LegacyPrivacyErasureAsset {
  id: string;
  workspacePath: string;
}

/** Erasure may span multiple durable transactions; retries resume the same fence. */
export interface PrivacyErasureRepository {
  readonly kind: 'privacy-erasure-repository';
  erase(): Promise<PrivacyErasureCounts>;
  pendingAssets(): Promise<PrivacyErasureAsset[]>;
  assetDeleted(asset: PrivacyErasureAsset | string): Promise<void>;
  refreshEmailAttachmentCustodyCleanupIntent(
    asset: Extract<PrivacyErasureAsset, { kind: 'email_attachment_custody' }>,
    observed: { generation: string; objectState: 'marker' | 'content' },
  ): Promise<void>;
  complete(): Promise<void>;
}
