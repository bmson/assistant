import { randomUUID } from 'node:crypto';
import {
  allowsManualMcpCredential,
  parseMcpOAuthState,
  pauseMcpOAuthState,
  type Records,
} from '@assistant/persistence';
import type { Transaction } from '@google-cloud/firestore';
import {
  assertPrivacyErasureFenceUnchanged,
  privacyErasureIsActive,
  readPrivacyErasureFence,
} from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type McpConnectionStatus = 'ready' | 'checking' | 'authorization_required' | 'error' | 'disabled';
type McpConnectionTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};
const MCP_CONNECTION_STATUSES: McpConnectionStatus[] = [
  'ready',
  'checking',
  'authorization_required',
  'error',
  'disabled',
];

export interface McpConnectionSummary {
  id: string;
  name: string;
  endpoint: string;
  status: McpConnectionStatus;
  enabled: boolean;
  serverName: string | null;
  serverVersion: string | null;
  instructions: string | null;
  tools: McpConnectionTool[];
  hasBearerToken: boolean;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

/** Owner-facing connection summaries. Encrypted credentials are never returned. */
export class FirestoreMcpConnectionReadRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  private async assertConfiguredOwner(): Promise<void> {
    const agents = await this.store.collection('agents').limit(2).get();
    const owner = agents.docs[0];
    if (
      !this.configuredAgentId ||
      agents.size !== 1 ||
      !owner ||
      owner.id !== documentKey(this.configuredAgentId) ||
      owner.get('id') !== this.configuredAgentId
    )
      throw new Error('MCP connection reads require exactly one configured agent');
  }

  async list(agentId: string): Promise<McpConnectionSummary[]> {
    if (agentId !== this.configuredAgentId)
      throw new Error('MCP connection read is outside the configured installation');
    await this.assertConfiguredOwner();
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const page = await this.store
      .collection('mcpConnections')
      .where('agentId', '==', agentId)
      .orderBy('name', 'asc')
      .get();
    const rows = page.docs.flatMap((doc) => {
      const row = decodeRecord<Records['mcpConnections']>(doc.data());
      if (
        row.agentId !== agentId ||
        documentKey(row.id) !== doc.id ||
        typeof row.name !== 'string' ||
        typeof row.endpoint !== 'string' ||
        typeof row.enabled !== 'boolean'
      )
        return [];
      const status = row.enabled ? row.status : 'disabled';
      if (!MCP_CONNECTION_STATUSES.includes(status as McpConnectionStatus)) return [];
      return [
        {
          id: row.id,
          name: row.name,
          endpoint: row.endpoint,
          status: status as McpConnectionStatus,
          enabled: row.enabled,
          serverName: row.serverName,
          serverVersion: row.serverVersion,
          instructions: row.instructions,
          tools: safeTools(row.tools),
          hasBearerToken: row.bearerTokenEncrypted != null,
          lastCheckedAt: row.lastCheckedAt,
          lastError: row.lastError,
        },
      ];
    });
    await this.assertConfiguredOwner();
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return rows;
  }

  /** Private runtime projection: bearer ciphertext is returned only to the tool adapter. */
  async getForTools(
    agentId: string,
    connectionId: string,
  ): Promise<{
    id: string;
    name: string;
    status: string;
    enabled: boolean;
    serverName: string | null;
    tools: McpConnectionTool[];
    endpoint: string;
    bearerTokenEncrypted: string | null;
    oauthState?: unknown;
  } | null> {
    if (agentId !== this.configuredAgentId)
      throw new Error('MCP connection read is outside the configured installation');
    await this.assertConfiguredOwner();
    const fence = await readPrivacyErasureFence(this.store, agentId);
    const snapshot = await this.store.doc('mcpConnections', connectionId).get();
    if (!snapshot.exists) {
      await this.assertConfiguredOwner();
      await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
      return null;
    }
    const row = decodeRecord<Records['mcpConnections']>(snapshot.data());
    const invalid =
      row.id !== connectionId ||
      documentKey(row.id) !== snapshot.id ||
      row.agentId !== agentId ||
      typeof row.name !== 'string' ||
      typeof row.endpoint !== 'string' ||
      typeof row.enabled !== 'boolean' ||
      typeof row.status !== 'string' ||
      !MCP_CONNECTION_STATUSES.includes(row.status as McpConnectionStatus);
    const result = invalid
      ? null
      : {
          id: row.id,
          name: row.name,
          status: row.enabled ? row.status : 'disabled',
          enabled: row.enabled,
          serverName: row.serverName,
          tools: safeTools(row.tools),
          endpoint: row.endpoint,
          bearerTokenEncrypted: row.bearerTokenEncrypted,
          ...(row.oauthState === undefined ? {} : { oauthState: row.oauthState }),
        };
    await this.assertConfiguredOwner();
    await assertPrivacyErasureFenceUnchanged(this.store, agentId, fence);
    return result;
  }
}

const pendingDiscoveryError = 'MCP discovery is unavailable in Firestore mode.';

function safeTools(value: unknown): McpConnectionTool[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((tool): McpConnectionTool[] => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return [];
    const row = tool as Record<string, unknown>;
    if (typeof row.name !== 'string') return [];
    return [
      {
        name: row.name,
        ...(typeof row.description === 'string' ? { description: row.description } : {}),
        ...(row.inputSchema &&
        typeof row.inputSchema === 'object' &&
        !Array.isArray(row.inputSchema)
          ? { inputSchema: row.inputSchema as Record<string, unknown> }
          : {}),
      },
    ];
  });
}

export type McpDiscoveryResult = {
  status: 'ready' | 'authorization_required' | 'error';
  serverName: string | null;
  serverVersion: string | null;
  instructions: string | null;
  tools: McpConnectionTool[];
  error: string | null;
};

/** Firestore owner mutations and fenced discovery persistence. */
export class FirestoreMcpConnectionMutationRepository {
  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
    readonly now: () => Date = () => new Date(),
    readonly newId: () => string = randomUUID,
  ) {}

  private async ownerInTransaction(transaction: Transaction): Promise<void> {
    const agents = await transaction.get(this.store.collection('agents').limit(2));
    const owner = agents.docs[0];
    if (
      !this.configuredAgentId ||
      agents.size !== 1 ||
      !owner ||
      owner.id !== documentKey(this.configuredAgentId) ||
      owner.get('id') !== this.configuredAgentId
    )
      throw new Error('MCP connection writes require exactly one configured agent');
    const erasure = await transaction.get(
      this.store.doc('privacyErasureJobs', this.configuredAgentId),
    );
    if (
      erasure.exists &&
      (erasure.get('agentId') !== this.configuredAgentId ||
        privacyErasureIsActive(erasure.get('status')))
    )
      throw new Error('Privacy erasure is in progress');
  }

  async create(input: {
    name: string;
    endpoint: string;
    bearerTokenEncrypted: string | null;
  }): Promise<{ connectionId: string; status: 'error'; error: string } | { error: string }> {
    const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 80);
    let endpoint: string | null = null;
    try {
      const url = new URL(input.endpoint.trim());
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
        url.hash = '';
        endpoint = url.toString();
      }
    } catch {
      // Report the same validation error as the SQL application use case.
    }
    if (!name) return { error: 'Give this MCP connection a name.' };
    if (!endpoint)
      return { error: 'Enter an HTTP or HTTPS MCP endpoint without embedded credentials.' };
    const id = this.newId();
    const createdAt = this.now();
    const ref = this.store.doc('mcpConnections', id);
    try {
      await this.store.db.runTransaction(async (tx) => {
        await this.ownerInTransaction(tx);
        const existing = await tx.get(
          this.store.collection('mcpConnections').where('agentId', '==', this.configuredAgentId),
        );
        if (existing.docs.some((doc) => doc.get('name') === name))
          throw new Error('A connection with that name already exists.');
        const row: Records['mcpConnections'] = {
          id,
          agentId: this.configuredAgentId,
          name,
          endpoint,
          bearerTokenEncrypted: input.bearerTokenEncrypted,
          enabled: true,
          status: 'error',
          serverName: null,
          serverVersion: null,
          instructions: null,
          tools: [],
          lastCheckedAt: null,
          lastError: pendingDiscoveryError,
          createdAt,
          updatedAt: createdAt,
        };
        tx.create(ref, encodeRecord(row));
      });
      return { connectionId: id, status: 'error', error: pendingDiscoveryError };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Unable to save connection.' };
    }
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ connectionId: string; status: string } | null> {
    const ref = this.store.doc('mcpConnections', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.ownerInTransaction(tx);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      const row = decodeRecord<Records['mcpConnections']>(snapshot.data());
      if (
        row.id !== id ||
        documentKey(row.id) !== snapshot.id ||
        row.agentId !== this.configuredAgentId
      )
        return null;
      const status = enabled ? 'error' : 'disabled';
      tx.update(ref, {
        enabled,
        ...(!enabled && row.oauthState != null
          ? {
              oauthState: encodeRecord(
                pauseMcpOAuthState(
                  parseMcpOAuthState(
                    row.oauthState,
                    { ownerId: this.configuredAgentId, connectionId: id },
                    row.endpoint,
                  ),
                ),
              ),
            }
          : {}),
        status,
        ...(enabled ? { lastError: pendingDiscoveryError } : {}),
        updatedAt: this.now(),
      });
      return { connectionId: id, status };
    });
  }

  /** Mark an enabled owner connection as checking and return private discovery inputs. */
  async beginDiscovery(id: string): Promise<{
    endpoint: string;
    bearerTokenEncrypted: string | null;
    attemptId: string;
  } | null> {
    const ref = this.store.doc('mcpConnections', id);
    const attemptId = this.newId();
    return this.store.db.runTransaction(async (tx) => {
      await this.ownerInTransaction(tx);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      const row = decodeRecord<Records['mcpConnections']>(snapshot.data());
      if (
        row.id !== id ||
        documentKey(row.id) !== snapshot.id ||
        row.agentId !== this.configuredAgentId ||
        !allowsManualMcpCredential(
          row.oauthState,
          {
            ownerId: this.configuredAgentId,
            connectionId: id,
          },
          row.endpoint,
        ) ||
        !row.enabled
      )
        return null;
      tx.update(ref, {
        status: 'checking',
        lastError: null,
        discoveryAttemptId: attemptId,
        updatedAt: this.now(),
      });
      return {
        endpoint: row.endpoint,
        bearerTokenEncrypted: row.bearerTokenEncrypted,
        attemptId,
      };
    });
  }

  /** Persist results only if the same owner still has this connection enabled. */
  async saveDiscovery(
    id: string,
    attemptId: string,
    discovery: McpDiscoveryResult,
  ): Promise<boolean> {
    const ref = this.store.doc('mcpConnections', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.ownerInTransaction(tx);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const row = decodeRecord<Records['mcpConnections']>(snapshot.data());
      if (
        row.id !== id ||
        documentKey(row.id) !== snapshot.id ||
        row.agentId !== this.configuredAgentId ||
        !allowsManualMcpCredential(
          row.oauthState,
          {
            ownerId: this.configuredAgentId,
            connectionId: id,
          },
          row.endpoint,
        ) ||
        !row.enabled ||
        row.status !== 'checking' ||
        snapshot.get('discoveryAttemptId') !== attemptId
      )
        return false;
      tx.update(ref, {
        status: discovery.status,
        serverName: discovery.serverName,
        serverVersion: discovery.serverVersion,
        instructions: discovery.instructions,
        tools: discovery.tools,
        lastCheckedAt: this.now(),
        lastError: discovery.error,
        discoveryAttemptId: null,
        updatedAt: this.now(),
      });
      return true;
    });
  }

  async delete(id: string): Promise<boolean> {
    const ref = this.store.doc('mcpConnections', id);
    return this.store.db.runTransaction(async (tx) => {
      await this.ownerInTransaction(tx);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const row = decodeRecord<Records['mcpConnections']>(snapshot.data());
      if (
        row.id !== id ||
        documentKey(row.id) !== snapshot.id ||
        row.agentId !== this.configuredAgentId
      )
        return false;
      tx.delete(ref);
      return true;
    });
  }
}
