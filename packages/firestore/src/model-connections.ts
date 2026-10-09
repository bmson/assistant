import { randomUUID } from 'node:crypto';
import {
  isRoutableModel,
  type ModelCatalogRepository,
  type ModelCatalogWrite,
  type ModelConnectionRepository,
  type ModelRoleAssignment,
  type Records,
} from '@assistant/persistence';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Row = Records['modelConnections'];

function modelRoleState(row: { primaryModel: string; fallbackModel: string; params: unknown }) {
  return { primaryModel: row.primaryModel, fallbackModel: row.fallbackModel, params: row.params };
}

function sameState(left: unknown, right: unknown): boolean {
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    );
  return stable(left) === stable(right);
}

function validRow(id: string, docId: string, value: unknown): Row | null {
  const row = decodeRecord<Row>(value);
  if (
    row?.id !== id ||
    documentKey(row.id) !== docId ||
    typeof row.kind !== 'string' ||
    typeof row.label !== 'string' ||
    typeof row.enabled !== 'boolean' ||
    !(row.updatedAt instanceof Date)
  )
    return null;
  return row;
}

/** Installation-wide provider connections, alongside the model catalog they serve. */
export class FirestoreModelConnectionRepository implements ModelConnectionRepository {
  readonly kind = 'model-connection-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async list(): Promise<Row[]> {
    const page = await this.store.collection('modelConnections').orderBy('label', 'asc').get();
    return page.docs.flatMap((doc) => {
      const row = validRow(String(doc.get('id')), doc.id, doc.data());
      return row ? [row] : [];
    });
  }

  async upsert(input: Parameters<ModelConnectionRepository['upsert']>[0]): Promise<Row> {
    const ref = this.store.doc('modelConnections', input.id);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? validRow(input.id, ref.id, snapshot.data()) : null;
      if (snapshot.exists && !existing) throw new Error('Stored model connection is malformed');
      const now = this.store.now();
      const row: Row = {
        id: input.id,
        kind: input.kind,
        label: input.label,
        baseUrl: input.baseUrl,
        apiKeyEncrypted:
          input.apiKeyEncrypted !== undefined
            ? input.apiKeyEncrypted
            : (existing?.apiKeyEncrypted ?? null),
        vertexProject: input.vertexProject,
        vertexLocation: input.vertexLocation,
        enabled: input.enabled,
        lastTestedAt: existing?.lastTestedAt ?? null,
        lastError: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      tx.set(ref, encodeRecord(row));
      return row;
    });
  }

  private async patch(id: string, change: (row: Row) => Partial<Row>): Promise<boolean> {
    const ref = this.store.doc('modelConnections', id);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const row = snapshot.exists ? validRow(id, ref.id, snapshot.data()) : null;
      if (!row) return false;
      tx.set(ref, encodeRecord({ ...row, ...change(row) }));
      return true;
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.patch(id, () => ({ enabled, updatedAt: this.store.now() }));
  }

  /** Leaves updatedAt alone so a test result does not rebuild the router's adapter. */
  recordTest(id: string, result: { ok: boolean; error?: string }): Promise<boolean> {
    return this.patch(id, () => ({
      lastTestedAt: this.store.now(),
      lastError: result.ok ? null : (result.error ?? 'failed'),
    }));
  }

  async remove(id: string): Promise<boolean> {
    const ref = this.store.doc('modelConnections', id);
    return this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      tx.delete(ref);
      return true;
    });
  }
}

/** The owner-editable model catalog and role routing, installation-wide. */
export class FirestoreModelCatalogRepository implements ModelCatalogRepository {
  readonly kind = 'model-catalog-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async listModels(): Promise<Records['models'][]> {
    const page = await this.store.collection('models').orderBy('label', 'asc').get();
    return page.docs.flatMap((doc) => {
      const row = decodeRecord<Records['models']>(doc.data());
      return typeof row?.id === 'string' && documentKey(row.id) === doc.id ? [row] : [];
    });
  }

  async listRoles(): Promise<Records['modelRoles'][]> {
    const page = await this.store.collection('modelRoles').get();
    return page.docs
      .flatMap((doc) => {
        const row = decodeRecord<Records['modelRoles']>(doc.data());
        return typeof row?.role === 'string' && documentKey(row.role) === doc.id ? [row] : [];
      })
      .sort((left, right) => left.role.localeCompare(right.role));
  }

  async listRoleRevisions(role?: string): Promise<Records['modelRoleRevisions'][]> {
    const collection = this.store.collection('modelRoleRevisions');
    const page = role ? await collection.where('role', '==', role).get() : await collection.get();
    return page.docs
      .flatMap((doc) => {
        const row = decodeRecord<Records['modelRoleRevisions']>(doc.data());
        return typeof row?.id === 'string' &&
          documentKey(row.id) === doc.id &&
          typeof row.role === 'string'
          ? [row]
          : [];
      })
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  async rollbackRoleRevision(revisionId: string): Promise<boolean> {
    const revisionRef = this.store.doc('modelRoleRevisions', revisionId);
    return this.store.db.runTransaction(async (tx) => {
      const revisionSnapshot = await tx.get(revisionRef);
      if (!revisionSnapshot.exists) return false;
      const revision = decodeRecord<Records['modelRoleRevisions']>(revisionSnapshot.data());
      if (revision.id !== revisionId || !revision.baselineKnown) return false;
      const roleRef = this.store.doc('modelRoles', revision.role);
      const roleSnapshot = await tx.get(roleRef);
      const current = roleSnapshot.exists
        ? decodeRecord<Records['modelRoles']>(roleSnapshot.data())
        : null;
      if (
        !current ||
        current.role !== revision.role ||
        !sameState(modelRoleState(current), revision.afterState)
      )
        return false;
      if (revision.beforeState === null) {
        if (revision.role !== 'voice') return false;
        tx.delete(roleRef);
        const rollback: Records['modelRoleRevisions'] = {
          id: randomUUID(),
          role: revision.role,
          beforeState: modelRoleState(current),
          afterState: null,
          source: `rollback:${revisionId}`,
          baselineKnown: true,
          requiresOwnerReview: false,
          createdAt: this.store.now(),
        };
        tx.create(this.store.doc('modelRoleRevisions', rollback.id), encodeRecord(rollback));
        return true;
      }
      const before = revision.beforeState as Partial<Records['modelRoles']>;
      if (typeof before.primaryModel !== 'string' || typeof before.fallbackModel !== 'string')
        return false;
      const modelRefs = [...new Set([before.primaryModel, before.fallbackModel])].map((id) =>
        this.store.doc('models', id),
      );
      const modelSnapshots = await tx.getAll(...modelRefs);
      for (const [index, snapshot] of modelSnapshots.entries()) {
        const model = snapshot.exists ? decodeRecord<Records['models']>(snapshot.data()) : null;
        if (
          model?.id !== [...new Set([before.primaryModel, before.fallbackModel])][index] ||
          !isRoutableModel(model)
        )
          return false;
      }
      const restored = {
        primaryModel: before.primaryModel,
        fallbackModel: before.fallbackModel,
        params: before.params ?? {},
      };
      tx.set(roleRef, encodeRecord({ ...current, ...restored, updatedAt: this.store.now() }));
      const rollback: Records['modelRoleRevisions'] = {
        id: randomUUID(),
        role: revision.role,
        beforeState: modelRoleState(current),
        afterState: restored,
        source: `rollback:${revisionId}`,
        baselineKnown: true,
        requiresOwnerReview: false,
        createdAt: this.store.now(),
      };
      tx.create(this.store.doc('modelRoleRevisions', rollback.id), encodeRecord(rollback));
      return true;
    });
  }

  async upsertModel(input: ModelCatalogWrite): Promise<void> {
    const ref = this.store.doc('models', input.id);
    await this.store.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const existing = snapshot.exists ? decodeRecord<Records['models']>(snapshot.data()) : null;
      if (existing && existing.id !== input.id) throw new Error('Model identity mismatch');
      const now = this.store.now();
      tx.set(
        ref,
        encodeRecord({ ...input, createdAt: existing?.createdAt ?? now, updatedAt: now }),
      );
    });
  }

  async setVoiceModel(modelId: string): Promise<void> {
    await this.store.db.runTransaction(async (tx) => {
      const roleRef = this.store.doc('modelRoles', 'voice');
      const [modelSnapshot, roleSnapshot] = await tx.getAll(
        this.store.doc('models', modelId),
        roleRef,
      );
      const model = modelSnapshot?.exists
        ? decodeRecord<Records['models']>(modelSnapshot.data())
        : null;
      if (model?.id !== modelId || !isRoutableModel(model))
        throw new Error(`Model ${modelId} is not enabled with prices`);
      const existing = roleSnapshot?.exists
        ? decodeRecord<Records['modelRoles']>(roleSnapshot.data())
        : null;
      tx.set(
        roleRef,
        encodeRecord({
          role: 'voice',
          params: existing?.params ?? {},
          primaryModel: modelId,
          fallbackModel: modelId,
          updatedAt: this.store.now(),
        }),
      );
      const after = {
        primaryModel: modelId,
        fallbackModel: modelId,
        params: existing?.params ?? {},
      };
      if (!existing || !sameState(modelRoleState(existing), after)) {
        const revision: Records['modelRoleRevisions'] = {
          id: randomUUID(),
          role: 'voice',
          beforeState: existing ? modelRoleState(existing) : null,
          afterState: after,
          source: 'owner-settings',
          baselineKnown: true,
          requiresOwnerReview: false,
          createdAt: this.store.now(),
        };
        tx.create(this.store.doc('modelRoleRevisions', revision.id), encodeRecord(revision));
      }
    });
  }

  async assignRoles(assignments: readonly ModelRoleAssignment[]): Promise<void> {
    if (assignments.length === 0) return;
    await this.store.db.runTransaction(async (tx) => {
      const wanted = [...new Set(assignments.flatMap((a) => [a.primaryModel, a.fallbackModel]))];
      const roleRefs = assignments.map((a) => this.store.doc('modelRoles', a.role));
      const modelRefs = wanted.map((id) => this.store.doc('models', id));
      const snapshots = await tx.getAll(...roleRefs, ...modelRefs);
      const roles = snapshots.slice(0, roleRefs.length);
      const catalog = snapshots.slice(roleRefs.length);
      catalog.forEach((snapshot, index) => {
        const row = snapshot.exists ? decodeRecord<Records['models']>(snapshot.data()) : null;
        if (row?.id !== wanted[index] || !isRoutableModel(row))
          throw new Error(`Model ${wanted[index]} is not enabled with prices`);
      });
      assignments.forEach((assignment, index) => {
        const snapshot = roles[index];
        const row = snapshot?.exists ? decodeRecord<Records['modelRoles']>(snapshot.data()) : null;
        if (!snapshot || row?.role !== assignment.role)
          throw new Error(`Unknown model role: ${assignment.role}`);
        tx.set(
          snapshot.ref,
          encodeRecord({
            ...row,
            primaryModel: assignment.primaryModel,
            fallbackModel: assignment.fallbackModel,
            updatedAt: this.store.now(),
          }),
        );
        const after = {
          primaryModel: assignment.primaryModel,
          fallbackModel: assignment.fallbackModel,
          params: row.params,
        };
        if (!sameState(modelRoleState(row), after)) {
          const revision: Records['modelRoleRevisions'] = {
            id: randomUUID(),
            role: assignment.role,
            beforeState: modelRoleState(row),
            afterState: after,
            source: 'owner-settings',
            baselineKnown: true,
            requiresOwnerReview: false,
            createdAt: this.store.now(),
          };
          tx.create(this.store.doc('modelRoleRevisions', revision.id), encodeRecord(revision));
        }
      });
    });
  }
}
