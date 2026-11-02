import { createHash } from 'node:crypto';

export interface EmbeddingSpace {
  provider: string;
  model: string;
  dimensions: number;
  revision: string;
}

/** PostgreSQL vector columns are physically fixed at vector(1536). */
export const POSTGRES_EMBEDDING_DIMENSIONS = 1536;

/** Validates and freezes one operation's exact embedding identity. */
export function snapshotEmbeddingSpace(space: EmbeddingSpace): Readonly<EmbeddingSpace> {
  const snapshot = {
    provider: space.provider,
    model: space.model,
    dimensions: space.dimensions,
    revision: space.revision,
  };
  validateEmbeddingSpace(snapshot);
  return Object.freeze(snapshot);
}

/** Canonical identity used by portable memory stores; exact revisions are required. */
export function embeddingSpaceIdentityKey(space: EmbeddingSpace): string {
  validateEmbeddingSpace(space);
  return createHash('sha256')
    .update(JSON.stringify([space.provider, space.model, space.dimensions, space.revision]))
    .digest('hex');
}

/** Canonical connection slug shared by catalog admission and gateway routing. */
export const GATEWAY_CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Extract a gateway-local model without crossing its connection namespace. */
export function gatewayModelId(connectionId: string, modelId: string): string {
  const prefix = `gw:${connectionId}:`;
  const id = modelId.startsWith(prefix) ? modelId.slice(prefix.length) : '';
  // Upstream names may contain slashes and colons; empty names/whitespace and
  // invalid connection slugs cannot name a canonical gateway route.
  if (!GATEWAY_CONNECTION_ID.test(connectionId) || !id || /\s/.test(id))
    throw new Error(`Gateway ${connectionId} cannot serve model identity: ${modelId || '<empty>'}`);
  return id;
}

/** OpenRouter model IDs already include their vendor namespace. */
export function embeddingModelId(space: EmbeddingSpace): string {
  if (space.model.startsWith('gw:')) {
    gatewayModelId(space.provider, space.model);
    return space.model;
  }
  if (space.provider === 'openrouter') return space.model;
  // Configurations may store either the provider-local model name or the
  // fully-qualified catalog ID. Preserve already-qualified IDs so a pinned
  // identity is compared with the exact model the router will invoke.
  if (
    space.model.startsWith(`${space.provider}/`) ||
    space.model.startsWith(`${space.provider}:`)
  ) {
    return space.model;
  }
  return `${space.provider}/${space.model}`;
}

export function validateEmbeddingSpace(space: EmbeddingSpace): void {
  if (
    typeof space.provider !== 'string' ||
    !space.provider.trim() ||
    typeof space.model !== 'string' ||
    !space.model.trim() ||
    typeof space.revision !== 'string' ||
    !space.revision.trim() ||
    !Number.isInteger(space.dimensions) ||
    space.dimensions < 1 ||
    space.dimensions > 2048
  )
    throw new Error('Invalid vector or incompatible embedding space');
}

export function validateEmbedding(space: EmbeddingSpace, vector: number[]): void {
  validateEmbeddingSpace(space);
  if (
    !Array.isArray(vector) ||
    vector.length !== space.dimensions ||
    !Array.from(vector).every(Number.isFinite) ||
    !vector.some((v) => v !== 0)
  ) {
    throw new Error('Invalid vector or incompatible embedding space');
  }
}
