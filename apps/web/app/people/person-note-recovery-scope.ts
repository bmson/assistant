import { createHmac } from 'node:crypto';
import { isValidFormSessionScope } from '@/app/auth-form-session-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stable in-memory component partition, not an authorization token or a new
 * auth generation. It is intentionally independent of whether fresh issuance
 * currently exists so same-owner pending recovery survives a bounded read miss.
 */
export function personNoteRecoveryPartition(input: {
  authSecret: string | undefined;
  ownerEmail: string | undefined;
  ownerId: string | null;
  formSessionScope: unknown;
  persistenceDriver: 'postgres' | 'firestore';
  workspaceId: string;
  databaseUrl: string;
  firestoreProject: string;
  firestoreDatabaseId: string;
}): string | null {
  const email = input.ownerEmail?.trim().toLowerCase();
  const ownerId = input.ownerId;
  if (
    !input.authSecret ||
    !email ||
    !ownerId ||
    !UUID.test(ownerId) ||
    !isValidFormSessionScope(input.formSessionScope) ||
    !input.workspaceId
  )
    return null;

  let serverScope: readonly string[];
  if (input.persistenceDriver === 'firestore') {
    if (!input.firestoreProject || !input.firestoreDatabaseId) return null;
    serverScope = [
      'firestore',
      input.firestoreProject,
      input.firestoreDatabaseId,
      input.workspaceId,
    ];
  } else {
    try {
      const database = new URL(input.databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(database.protocol)) return null;
      serverScope = [
        'postgres',
        database.protocol,
        database.hostname.toLowerCase(),
        database.port,
        database.pathname,
        input.workspaceId,
      ];
    } catch {
      return null;
    }
  }

  return createHmac('sha256', input.authSecret)
    .update(JSON.stringify([email, ownerId.toLowerCase(), input.formSessionScope, serverScope]))
    .digest('hex');
}
