import { randomUUID } from 'node:crypto';
import {
  type EmbeddingSpace,
  type OwnerSkillInput,
  type SkillMutationRepository,
  type SkillReflectionCommit,
  type SkillReflectionCommitResult,
  snapshotEmbeddingSpace,
  validateEmbedding,
  validateSkillEmbedding,
  validateSkillEmbeddingSpace,
} from '@assistant/persistence';
import { FieldValue, type Transaction } from '@google-cloud/firestore';
import { embeddingSpaceKey } from './memory.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { skillFromDocument } from './skill-library.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

/** Writes and hard-deletes owner skills under the configured-agent erasure fence. */
export class FirestoreSkillMutationRepository implements SkillMutationRepository {
  readonly kind = 'skill-mutation-repository' as const;
  readonly space?: EmbeddingSpace;

  constructor(
    readonly store: InstallationStore,
    space?: EmbeddingSpace,
  ) {
    this.space = space ? snapshotEmbeddingSpace(space) : undefined;
  }

  async assertOwnerWritable(agentId: string): Promise<void> {
    if (!agentId) throw new Error('Skill owner is required');
    await this.store.db.runTransaction((tx) => this.ownerFence(tx, agentId), { readOnly: true });
  }

  async assertOwnerCanEdit(agentId: string, skillId: string): Promise<void> {
    if (!agentId || !skillId) throw new Error('Skill owner and identity are required');
    await this.store.db.runTransaction(
      async (tx) => {
        await this.ownerFence(tx, agentId);
        const existing = await tx.get(this.store.doc('skills', skillId));
        if (!existing.exists || existing.get('agentId') !== agentId)
          throw new Error('Skill not found');
        this.validExisting(existing.data(), existing.id, agentId);
      },
      { readOnly: true },
    );
  }

  private validateWrite(embedding: number[]): EmbeddingSpace {
    if (!this.space) throw new Error('Skill writes require an embedding space');
    validateSkillEmbeddingSpace(this.space);
    validateEmbedding(this.space, embedding);
    return this.space;
  }

  private async ownerFence(tx: Transaction, agentId: string): Promise<string | null> {
    const agents = await tx.get(this.store.collection('agents').limit(2));
    const agent = agents.docs[0];
    if (
      agents.size !== 1 ||
      !agent ||
      agent.id !== documentKey(agentId) ||
      agent.get('id') !== agentId
    )
      throw new Error('Skill mutation requires one matching configured owner');
    const erasure = await tx.get(this.store.doc('privacyErasureJobs', agentId));
    if (
      erasure.exists &&
      (erasure.get('agentId') !== agentId ||
        privacyErasureIsActive(erasure.get('status')) ||
        !erasure.updateTime)
    )
      throw new Error('Privacy erasure is in progress');
    return erasure.exists
      ? `${erasure.updateTime?.seconds}:${erasure.updateTime?.nanoseconds}`
      : null;
  }

  async libraryRevision(agentId: string): Promise<string> {
    return this.store.db.runTransaction(async (tx) => {
      const [snapshot, erasure] = await Promise.all([
        tx.get(this.store.doc('skillLibraryRevisions', agentId)),
        tx.get(this.store.doc('privacyErasureJobs', agentId)),
      ]);
      const revision = snapshot.get('revision') ?? 0;
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new Error('Invalid skill library revision');
      let privacy: string | null = null;
      if (erasure.exists) {
        if (
          erasure.get('agentId') !== agentId ||
          privacyErasureIsActive(erasure.get('status')) ||
          !erasure.updateTime
        )
          throw new Error('Privacy erasure is in progress');
        privacy = `${erasure.updateTime.seconds}:${erasure.updateTime.nanoseconds}`;
      }
      return JSON.stringify({ library: String(revision), privacy });
    });
  }

  private async revisionInTransaction(tx: Transaction, agentId: string): Promise<number> {
    const snapshot = await tx.get(this.store.doc('skillLibraryRevisions', agentId));
    const revision = snapshot.get('revision') ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('Invalid skill library revision');
    return revision;
  }

  private advanceRevision(tx: Transaction, agentId: string, revision: number): void {
    if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Skill library revision exhausted');
    tx.set(this.store.doc('skillLibraryRevisions', agentId), {
      agentId,
      revision: revision + 1,
      updatedAt: this.store.now(),
    });
  }

  async saveOwner(agentId: string, input: OwnerSkillInput, embedding: number[]): Promise<void> {
    const space = this.validateWrite(embedding);
    if (!agentId || !input.name || !input.steps) throw new Error('Name and steps are required.');
    await this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx, agentId);
      const libraryRevision = await this.revisionInTransaction(tx, agentId);
      const skills = await tx.get(
        this.store.collection('skills').where('agentId', '==', agentId).limit(501),
      );
      if (skills.size > 500)
        throw new Error('Learned-skill library exceeds the mobile workspace limit');
      const matches = skills.docs.filter((doc) => doc.get('name') === input.name);
      if (matches.length > 1) throw new Error('Duplicate learned-skill name');
      const existing = matches[0];
      const now = this.store.now();
      const revision = randomUUID();
      if (existing) {
        this.validExisting(existing.data(), existing.id, agentId);
        tx.update(existing.ref, {
          preconditions: input.preconditions,
          steps: input.steps,
          gotchas: input.gotchas,
          embedding: FieldValue.vector(embedding),
          embeddingSpaceKey: embeddingSpaceKey(space),
          embeddingSpace: embeddingSpaceKey(space),
          retrievalRevision: revision,
          ownerAuthored: true,
          deprecated: false,
          lastVerifiedAt: now,
          updatedAt: now,
        });
      } else {
        if (skills.size >= 500)
          throw new Error('Learned-skill library exceeds the mobile workspace limit');
        const id = randomUUID();
        tx.create(
          this.store.doc('skills', id),
          encodeRecord({
            id,
            agentId,
            name: input.name,
            preconditions: input.preconditions,
            steps: input.steps,
            gotchas: input.gotchas,
            embedding: FieldValue.vector(embedding),
            embeddingSpaceKey: embeddingSpaceKey(space),
            embeddingSpace: embeddingSpaceKey(space),
            retrievalRevision: revision,
            sourceTaskId: null,
            originTrust: 'owner',
            ownerAuthored: true,
            useCount: 0,
            successCount: 0,
            failureCount: 0,
            lastVerifiedAt: now,
            deprecated: false,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      this.advanceRevision(tx, agentId, libraryRevision);
    });
  }

  /** Whether the owner wrote the same-named skill, which reflection never overwrites. */
  async ownerAuthoredNamed(agentId: string, name: string): Promise<boolean> {
    const skills = await this.store
      .collection('skills')
      .where('agentId', '==', agentId)
      .where('name', '==', name)
      .limit(2)
      .get();
    return skills.docs.some((doc) => doc.get('ownerAuthored') === true);
  }

  libraryRevisionForReflection(agentId: string): Promise<string> {
    return this.libraryRevision(agentId);
  }

  /**
   * Insert or revise a reflected skill under the same fence as owner writes.
   * An owner-authored skill wins, and a full library is left as it is.
   */
  async commitReflection(input: SkillReflectionCommit): Promise<SkillReflectionCommitResult> {
    if (!input.agentId || !input.taskId)
      throw new Error('Skill reflection requires task ownership');
    const space = input.embedding ? this.validateWrite(input.embedding) : undefined;
    if (input.embedding && input.embeddingSpaceKey !== embeddingSpaceKey(space as EmbeddingSpace))
      throw new Error('Skill embedding space changed');
    if (input.skill && (!input.skill.name || !input.skill.steps || !input.embedding || !space))
      throw new Error('A reflected skill requires content and a valid embedding');
    return this.store.db.runTransaction(async (tx) => {
      const observedPrivacyFence = await this.ownerFence(tx, input.agentId);
      let expectedFence: { library?: unknown; privacy?: unknown };
      try {
        expectedFence = JSON.parse(input.expectedLibraryRevision) as {
          library?: unknown;
          privacy?: unknown;
        };
      } catch {
        throw new Error('Skill reflection revision token is malformed');
      }
      if (expectedFence.privacy !== observedPrivacyFence) return { status: 'ineligible' };
      const taskRef = this.store.doc('tasks', input.taskId);
      const taskSnapshot = await tx.get(taskRef);
      const task = taskSnapshot.exists
        ? decodeRecord<Record<string, unknown>>(taskSnapshot.data())
        : null;
      const trigger = task?.trigger as
        | {
            source?: unknown;
            payload?: { quotesExternalContent?: unknown; taintedOrigin?: unknown };
          }
        | null
        | undefined;
      const externalTaint =
        trigger?.payload?.taintedOrigin === true ||
        (trigger?.source === 'email' &&
          !(task?.trust === 'owner' && trigger.payload?.quotesExternalContent === false));
      if (
        !task ||
        task.id !== input.taskId ||
        task.agentId !== input.agentId ||
        task.status !== 'done' ||
        (task.trust !== 'owner' && task.trust !== 'assistant') ||
        externalTaint ||
        (task.state &&
          typeof task.state === 'object' &&
          (task.state as Record<string, unknown>).untrustedContext === true)
      )
        return { status: 'ineligible' };
      const state =
        task.state && typeof task.state === 'object' && !Array.isArray(task.state)
          ? { ...(task.state as Record<string, unknown>) }
          : {};
      if (state.skillReflectionReceipt) return { status: 'already_processed' };
      const libraryRevision = await this.revisionInTransaction(tx, input.agentId);

      let status: SkillReflectionCommitResult['status'];
      let skillId: string | null = null;
      if (!input.skill) {
        status = 'no_skill';
      } else if (String(libraryRevision) !== expectedFence.library) {
        status = 'superseded';
      } else {
        const skills = await tx.get(
          this.store.collection('skills').where('agentId', '==', input.agentId).limit(501),
        );
        const matches = skills.docs.filter((doc) => doc.get('name') === input.skill?.name);
        if (matches.length > 1) throw new Error('Duplicate learned-skill name');
        const existing = matches[0];
        const now = this.store.now();
        if (existing) {
          this.validExisting(existing.data(), existing.id, input.agentId);
          skillId = existing.id;
          if (existing.get('ownerAuthored') === true) {
            status = 'owner_authored';
          } else {
            tx.update(existing.ref, {
              preconditions: input.skill.preconditions,
              steps: input.skill.steps,
              gotchas: input.skill.gotchas,
              embedding: FieldValue.vector(input.embedding as number[]),
              embeddingSpaceKey: embeddingSpaceKey(space as EmbeddingSpace),
              embeddingSpace: embeddingSpaceKey(space as EmbeddingSpace),
              retrievalRevision: randomUUID(),
              deprecated: false,
              lastVerifiedAt: now,
              updatedAt: now,
            });
            status = 'revised';
            this.advanceRevision(tx, input.agentId, libraryRevision);
          }
        } else if (skills.size >= 500) {
          status = 'capacity';
        } else {
          skillId = randomUUID();
          tx.create(
            this.store.doc('skills', skillId),
            encodeRecord({
              id: skillId,
              agentId: input.agentId,
              name: input.skill.name,
              preconditions: input.skill.preconditions,
              steps: input.skill.steps,
              gotchas: input.skill.gotchas,
              embedding: FieldValue.vector(input.embedding as number[]),
              embeddingSpaceKey: embeddingSpaceKey(space as EmbeddingSpace),
              embeddingSpace: embeddingSpaceKey(space as EmbeddingSpace),
              retrievalRevision: randomUUID(),
              sourceTaskId: input.skill.sourceTaskId,
              originTrust: input.skill.originTrust,
              ownerAuthored: false,
              useCount: 0,
              successCount: 0,
              failureCount: 0,
              lastVerifiedAt: now,
              deprecated: false,
              createdAt: now,
              updatedAt: now,
            }),
          );
          status = 'created';
          this.advanceRevision(tx, input.agentId, libraryRevision);
        }
      }
      tx.update(taskRef, {
        state: {
          ...state,
          skillReflectionReceipt: {
            status,
            author: 'reflection',
            skillId,
            libraryRevision: String(libraryRevision),
            recordedAt: this.store.now().toISOString(),
          },
        },
        updatedAt: this.store.now(),
      });
      if ((status === 'created' || status === 'revised') && skillId) return { status, skillId };
      if (status === 'created' || status === 'revised')
        throw new Error('Committed skill reflection did not return a skill identity');
      return { status };
    });
  }

  async editOwner(
    agentId: string,
    skillId: string,
    input: OwnerSkillInput,
    embedding: number[],
  ): Promise<void> {
    const space = this.validateWrite(embedding);
    if (!agentId || !skillId || !input.name || !input.steps)
      throw new Error('Name and steps are required.');
    await this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx, agentId);
      const libraryRevision = await this.revisionInTransaction(tx, agentId);
      const skills = await tx.get(
        this.store.collection('skills').where('agentId', '==', agentId).limit(501),
      );
      if (skills.size > 500)
        throw new Error('Learned-skill library exceeds the mobile workspace limit');
      const ref = this.store.doc('skills', skillId);
      const existing = await tx.get(ref);
      if (!existing.exists || existing.get('agentId') !== agentId)
        throw new Error('Skill not found');
      this.validExisting(existing.data(), existing.id, agentId);
      if (skills.docs.some((doc) => doc.id !== ref.id && doc.get('name') === input.name))
        throw new Error('Duplicate learned-skill name');
      const now = this.store.now();
      tx.update(ref, {
        name: input.name,
        preconditions: input.preconditions,
        steps: input.steps,
        gotchas: input.gotchas,
        embedding: FieldValue.vector(embedding),
        embeddingSpaceKey: embeddingSpaceKey(space),
        embeddingSpace: embeddingSpaceKey(space),
        retrievalRevision: randomUUID(),
        ownerAuthored: true,
        deprecated: false,
        updatedAt: now,
      });
      this.advanceRevision(tx, agentId, libraryRevision);
    });
  }

  private validExisting(value: unknown, documentId: string, agentId: string): void {
    skillFromDocument(value, documentId, agentId);
    const row = decodeRecord<Record<string, unknown>>(value);
    if (
      !(row.createdAt instanceof Date) ||
      !Number.isFinite(row.createdAt.getTime()) ||
      (row.originTrust !== 'owner' && row.originTrust !== 'assistant') ||
      !(row.sourceTaskId === null || typeof row.sourceTaskId === 'string') ||
      !(
        row.lastVerifiedAt === null ||
        (row.lastVerifiedAt instanceof Date && Number.isFinite(row.lastVerifiedAt.getTime()))
      ) ||
      !(row.embedding === null || Array.isArray(row.embedding))
    )
      throw new Error('Invalid learned-skill document');
    if (Array.isArray(row.embedding)) {
      validateSkillEmbedding(row.embedding as number[], (row.embedding as number[]).length);
      if (
        typeof row.embeddingSpace !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.embeddingSpace) ||
        typeof row.retrievalRevision !== 'string' ||
        !row.retrievalRevision
      )
        throw new Error('Invalid learned-skill vector provenance');
    }
  }

  setDeprecated(agentId: string, skillId: string, deprecated: boolean): Promise<void> {
    if (typeof deprecated !== 'boolean') throw new Error('deprecated must be a boolean');
    return this.change(agentId, skillId, deprecated);
  }

  delete(agentId: string, skillId: string): Promise<void> {
    return this.change(agentId, skillId, null);
  }

  private async change(
    agentId: string,
    skillId: string,
    deprecated: boolean | null,
  ): Promise<void> {
    if (!agentId || !skillId) throw new Error('Skill owner and ID are required');
    await this.store.db.runTransaction(async (tx) => {
      await this.ownerFence(tx, agentId);
      const libraryRevision = await this.revisionInTransaction(tx, agentId);

      const ref = this.store.doc('skills', skillId);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists || snapshot.get('agentId') !== agentId)
        throw new Error('Skill not found');
      this.validExisting(snapshot.data(), snapshot.id, agentId);

      if (deprecated === null) tx.delete(ref);
      else tx.update(ref, { deprecated, updatedAt: this.store.now() });
      this.advanceRevision(tx, agentId, libraryRevision);
    });
  }
}
