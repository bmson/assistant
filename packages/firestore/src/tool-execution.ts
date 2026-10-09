import { randomUUID } from 'node:crypto';
import type {
  ApprovedToolCall,
  CachedToolCallInput,
  ClaimApprovedToolCallInput,
  ClaimApprovedToolCallResult,
  Records,
  ToolExecutionOutcome,
  ToolExecutionRepository,
} from '@assistant/persistence';
import {
  advanceExternalEffect,
  approvalPolicyFingerprint,
  type ExternalEffectProgress,
  idempotencyIdentityDigest,
  MAX_APPROVAL_POLICY_SNAPSHOT_ROWS,
  mcpApprovalBindingFingerprint,
  modelToolCallIdentityDigest,
  toolCallReceiptKeyId,
  toolCallReplayKeysForStart,
} from '@assistant/persistence';
import { assertPrivacyErasureInactiveInTransaction } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

function read<T>(snapshot: { exists: boolean; data(): unknown }, id: string): T | null {
  if (!snapshot.exists) return null;
  const value = decodeRecord<T>(snapshot.data());
  return value && typeof value === 'object' && (value as { id?: unknown }).id === id ? value : null;
}

function validReceipt(
  value: Records['toolCallReceipts'] | null,
): value is Records['toolCallReceipts'] {
  return Boolean(
    value &&
      typeof value.agentId === 'string' &&
      typeof value.taskId === 'string' &&
      value.toolCallId === value.id &&
      (value.modelToolCallIdHash === null || /^[a-f0-9]{64}$/.test(value.modelToolCallIdHash)) &&
      (value.idempotencyKeyHash === null || /^[a-f0-9]{64}$/.test(value.idempotencyKeyHash)) &&
      typeof value.toolName === 'string' &&
      ['completed', 'failed', 'unknown', 'not_executed'].includes(value.effectOutcome) &&
      value.recordedAt instanceof Date,
  );
}

function linked(
  toolCall: Records['toolCalls'],
  task: Records['tasks'],
  approval: Records['approvals'] | null,
  agentId: string,
  taskId: string,
  toolCallId: string,
): ApprovedToolCall | null {
  if (
    task.id !== taskId ||
    task.agentId !== agentId ||
    toolCall.id !== toolCallId ||
    toolCall.taskId !== taskId ||
    (approval &&
      (approval.toolCallId !== toolCallId ||
        approval.taskId !== taskId ||
        approval.status !== 'approved'))
  )
    return null;
  return { toolCall, task, approval };
}

export class FirestoreToolExecutionRepository implements ToolExecutionRepository {
  readonly kind = 'tool-execution-repository' as const;
  constructor(readonly store: InstallationStore) {}

  private async receiptForKey(input: {
    agentId: string;
    taskId: string;
    kind: 'model_tool_call' | 'idempotency';
    digest: string;
  }): Promise<Records['toolCallReceipts'] | null> {
    const keyId = toolCallReceiptKeyId(input.kind, input.digest);
    const keySnapshot = await this.store.doc('toolCallReceiptKeys', keyId).get();
    const key = read<Records['toolCallReceiptKeys']>(keySnapshot, keyId);
    if (
      !key ||
      key.kind !== input.kind ||
      key.digest !== input.digest ||
      key.agentId !== input.agentId ||
      (input.kind === 'model_tool_call' &&
        (key.agentId !== input.agentId || key.taskId !== input.taskId))
    )
      return null;
    const receiptId = key.receiptId;
    const receipt = read<Records['toolCallReceipts']>(
      await this.store.doc('toolCallReceipts', receiptId).get(),
      receiptId,
    );
    if (
      !receipt ||
      !validReceipt(receipt) ||
      receipt.id !== key.receiptId ||
      receipt.toolCallId !== key.receiptId ||
      receipt.agentId !== input.agentId ||
      receipt.taskId !== input.taskId ||
      receipt.taskId !== key.taskId ||
      (input.kind === 'model_tool_call' && receipt.modelToolCallIdHash !== input.digest) ||
      (input.kind === 'idempotency' && receipt.idempotencyKeyHash !== input.digest)
    )
      return null;
    return receipt;
  }

  async findReceiptByToolCallId(
    agentId: string,
    taskId: string,
    toolCallId: string,
  ): Promise<Records['toolCallReceipts'] | null> {
    if (!agentId || !taskId || !toolCallId) return null;
    const receipt = read<Records['toolCallReceipts']>(
      await this.store.doc('toolCallReceipts', toolCallId).get(),
      toolCallId,
    );
    return validReceipt(receipt) &&
      receipt.agentId === agentId &&
      receipt.taskId === taskId &&
      receipt.toolCallId === toolCallId
      ? receipt
      : null;
  }

  async findReceiptByModelToolCallId(
    agentId: string,
    taskId: string,
    modelToolCallId: string,
  ): Promise<Records['toolCallReceipts'] | null> {
    const digest = modelToolCallIdentityDigest(agentId, taskId, modelToolCallId);
    return digest ? this.receiptForKey({ agentId, taskId, kind: 'model_tool_call', digest }) : null;
  }

  async findReceiptByIdempotencyKey(
    agentId: string,
    taskId: string,
    idempotencyKey: string,
  ): Promise<Records['toolCallReceipts'] | null> {
    const digest = idempotencyIdentityDigest(idempotencyKey);
    return digest ? this.receiptForKey({ agentId, taskId, kind: 'idempotency', digest }) : null;
  }

  async load(
    agentId: string,
    taskId: string,
    toolCallId: string,
  ): Promise<ApprovedToolCall | null> {
    if (!toolCallId || !taskId || !agentId) return null;
    const [toolSnapshot, taskSnapshot] = await Promise.all([
      this.store.doc('toolCalls', toolCallId).get(),
      this.store.doc('tasks', taskId).get(),
    ]);
    const toolCall = read<Records['toolCalls']>(toolSnapshot, toolCallId);
    const task = read<Records['tasks']>(taskSnapshot, taskId);
    if (!toolCall || !task) return null;
    const approval = toolCall.approvalId
      ? read<Records['approvals']>(
          await this.store.doc('approvals', toolCall.approvalId).get(),
          toolCall.approvalId,
        )
      : null;
    if (toolCall.approvalId && !approval) return null;
    return linked(toolCall, task, approval, agentId, taskId, toolCallId);
  }

  async findByModelToolCallId(
    agentId: string,
    taskId: string,
    modelToolCallId: string,
  ): Promise<{ toolCall: Records['toolCalls']; approval: Records['approvals'] | null } | null> {
    if (!agentId || !taskId || !modelToolCallId) return null;
    const task = read<Records['tasks']>(await this.store.doc('tasks', taskId).get(), taskId);
    if (!task || task.agentId !== agentId) return null;
    const snapshot = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .limit(501)
      .get();
    if (snapshot.size >= 501) throw new Error('tool call recovery scan exceeded bound');
    const matches = snapshot.docs
      .map((doc) => {
        const decoded = decodeRecord<Records['toolCalls']>(doc.data());
        // Collection snapshots expose the encoded Firestore key, while the
        // record carries the stable task/call identifier used by repositories.
        return decoded && documentKey(decoded.id) === doc.id ? decoded : null;
      })
      .filter((call): call is Records['toolCalls'] => {
        if (!call || call.taskId !== taskId) return false;
        const decision = call.decision as { modelToolCallId?: unknown } | null;
        return decision?.modelToolCallId === modelToolCallId;
      });
    if (matches.length !== 1) return null;
    const toolCall = matches[0];
    if (!toolCall) return null;
    const approval = toolCall.approvalId
      ? read<Records['approvals']>(
          await this.store.doc('approvals', toolCall.approvalId).get(),
          toolCall.approvalId,
        )
      : null;
    if (
      toolCall.approvalId &&
      (!approval || approval.taskId !== taskId || approval.toolCallId !== toolCall.id)
    ) {
      return null;
    }
    return { toolCall, approval };
  }

  async claim(input: ClaimApprovedToolCallInput): Promise<ClaimApprovedToolCallResult> {
    return this.store.db.runTransaction(async (tx) => {
      const ownerRef = this.store.doc('agents', input.agentId);
      const ownerSnapshot = await tx.get(ownerRef);
      if (!ownerSnapshot.exists || ownerSnapshot.get('id') !== input.agentId) return null;
      const taskRef = this.store.doc('tasks', input.taskId);
      const toolRef = this.store.doc('toolCalls', input.toolCallId);
      const [taskSnapshot, toolSnapshot] = await Promise.all([tx.get(taskRef), tx.get(toolRef)]);
      const task = read<Records['tasks']>(taskSnapshot, input.taskId);
      const toolCall = read<Records['toolCalls']>(toolSnapshot, input.toolCallId);
      if (!task || !toolCall || toolCall.status !== 'approved') return null;
      let approval: Records['approvals'] | null = null;
      if (toolCall.approvalId) {
        const approvalSnapshot = await tx.get(this.store.doc('approvals', toolCall.approvalId));
        approval = read<Records['approvals']>(approvalSnapshot, toolCall.approvalId);
        if (!approval) return null;
      }
      const current = linked(
        toolCall,
        task,
        approval,
        input.agentId,
        input.taskId,
        input.toolCallId,
      );
      if (!current) return null;
      const markStaleAuthorization = async (): Promise<ClaimApprovedToolCallResult> => {
        // Persist the revoked authorization in the same transaction as the
        // claim refusal. Keep the reservation identity so crash recovery can
        // release it, but never persist policy or MCP binding material.
        await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
        const error = 'approval authority changed before execution; request fresh approval';
        const finishedAt = this.store.now();
        const reservationId =
          typeof input.decision.reservationId === 'string' ? input.decision.reservationId : null;
        const modelToolCallId =
          typeof input.decision.modelToolCallId === 'string'
            ? input.decision.modelToolCallId
            : null;
        const failed = {
          ...toolCall,
          status: 'failed',
          decision: {
            ...(reservationId ? { reservationId } : {}),
            ...(modelToolCallId ? { modelToolCallId } : {}),
          },
          result: null,
          error,
          finishedAt,
        };
        tx.update(ownerRef, { updatedAt: finishedAt });
        tx.update(toolRef, encodeRecord(failed));
        return { type: 'stale_authorization', error };
      };
      if (input.expectedTaskStatus && task.status !== input.expectedTaskStatus) return null;
      if (
        input.expectedApprovalId !== undefined &&
        toolCall.approvalId !== input.expectedApprovalId
      )
        return null;
      if (
        input.expectedResolutionPayload !== undefined &&
        JSON.stringify(approval?.resolutionPayload ?? null) !==
          JSON.stringify(input.expectedResolutionPayload)
      )
        return markStaleAuthorization();
      if (task.trust !== input.expectedTaskTrust) return markStaleAuthorization();
      if (
        !input.expectedPolicyFingerprint ||
        !/^[a-f0-9]{64}$/.test(input.expectedPolicyFingerprint)
      )
        return markStaleAuthorization();
      const policySnapshots = await tx.get(
        this.store
          .collection('approvalPolicies')
          .where('agentId', '==', input.agentId)
          .where('toolName', '==', toolCall.toolName)
          .orderBy('id', 'asc')
          .limit(MAX_APPROVAL_POLICY_SNAPSHOT_ROWS + 1),
      );
      if (policySnapshots.size > MAX_APPROVAL_POLICY_SNAPSHOT_ROWS) return markStaleAuthorization();
      let malformedPolicy = false;
      const policyRows = policySnapshots.docs.map((snapshot) => {
        const row = decodeRecord<Records['approvalPolicies']>(snapshot.data());
        if (
          !row ||
          typeof row !== 'object' ||
          Array.isArray(row) ||
          row.id !== snapshot.get('id') ||
          documentKey(row.id) !== snapshot.id ||
          row.agentId !== input.agentId ||
          row.toolName !== toolCall.toolName
        )
          malformedPolicy = true;
        return row;
      });
      if (malformedPolicy) return markStaleAuthorization();
      try {
        if (approvalPolicyFingerprint(policyRows) !== input.expectedPolicyFingerprint)
          return markStaleAuthorization();
      } catch {
        return markStaleAuthorization();
      }

      if (toolCall.toolName === 'mcp.call') {
        const binding = input.expectedMcpBinding;
        if (
          !binding ||
          binding.connectionId !== (input.args as { connectionId?: unknown }).connectionId ||
          !/^[a-f0-9]{64}$/.test(binding.fingerprint)
        )
          return markStaleAuthorization();
        const connectionSnapshot = await tx.get(
          this.store.doc('mcpConnections', binding.connectionId),
        );
        const connection = connectionSnapshot.exists
          ? decodeRecord<Records['mcpConnections']>(connectionSnapshot.data())
          : null;
        let bindingMatches = false;
        try {
          bindingMatches = Boolean(
            connection &&
              connection.id === binding.connectionId &&
              connection.agentId === input.agentId &&
              mcpApprovalBindingFingerprint(
                connection,
                String((input.args as { toolName?: unknown }).toolName),
              ) === binding.fingerprint,
          );
        } catch {
          bindingMatches = false;
        }
        if (!bindingMatches) return markStaleAuthorization();
      } else if (input.expectedMcpBinding) {
        return markStaleAuthorization();
      }

      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const startedAt = input.startedAt ?? this.store.now();
      // A write to the stable owner document serializes this claim with every
      // approval-policy writer. Firestore retries if either side raced.
      tx.update(ownerRef, { updatedAt: startedAt });
      const next = {
        ...toolCall,
        status: 'executing',
        args: input.args,
        decision: input.decision,
        startedAt,
      };
      tx.update(toolRef, encodeRecord(next));
      return { ...current, toolCall: next };
    });
  }

  async checkpointExternalEffect(input: {
    agentId: string;
    taskId: string;
    toolCallId: string;
    progress: ExternalEffectProgress;
  }): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const taskSnapshot = await tx.get(this.store.doc('tasks', input.taskId));
      const ref = this.store.doc('toolCalls', input.toolCallId);
      const snapshot = await tx.get(ref);
      const task = read<Records['tasks']>(taskSnapshot, input.taskId);
      const call = read<Records['toolCalls']>(snapshot, input.toolCallId);
      if (
        !task ||
        task.agentId !== input.agentId ||
        !call ||
        call.taskId !== input.taskId ||
        call.status !== 'executing'
      )
        return false;
      const decision = (call.decision ?? {}) as Record<string, unknown>;
      const progress = advanceExternalEffect(decision.externalEffect, input.progress);
      tx.update(ref, encodeRecord({ decision: { ...decision, externalEffect: progress } }));
      return true;
    });
  }

  async outcome(input: ToolExecutionOutcome): Promise<boolean> {
    return this.store.db.runTransaction(async (tx) => {
      const taskSnapshot = await tx.get(this.store.doc('tasks', input.taskId));
      const toolRef = this.store.doc('toolCalls', input.toolCallId);
      const toolSnapshot = await tx.get(toolRef);
      const task = read<Records['tasks']>(taskSnapshot, input.taskId);
      const toolCall = read<Records['toolCalls']>(toolSnapshot, input.toolCallId);
      if (
        !task ||
        !toolCall ||
        toolCall.taskId !== input.taskId ||
        task.agentId !== input.agentId ||
        (input.fromStatus ? toolCall.status !== input.fromStatus : toolCall.status !== 'executing')
      )
        return false;
      const next = {
        ...toolCall,
        status: input.status,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        finishedAt: input.finishedAt ?? this.store.now(),
      };
      tx.update(toolRef, encodeRecord(next));
      return true;
    });
  }

  async contacts(): Promise<Array<{ emails: string[]; phones: string[] }>> {
    const snapshot = await this.store.collection('contacts').limit(1000).get();
    if (snapshot.size >= 1000) throw new Error('Firestore contact scan exceeded bound');
    return snapshot.docs.map((doc) => {
      const value = decodeRecord<{ emails?: unknown; phones?: unknown }>(doc.data());
      return {
        emails: Array.isArray(value.emails)
          ? value.emails.filter((v): v is string => typeof v === 'string')
          : [],
        phones: Array.isArray(value.phones)
          ? value.phones.filter((v): v is string => typeof v === 'string')
          : [],
      };
    });
  }

  async underRateLimit(scope: string, toolName: string, now = this.store.now()): Promise<boolean> {
    const policy = await this.store.doc('rateLimits', scope).get();
    if (!policy.exists) return true;
    const value = decodeRecord<{ maxPerHour?: unknown; maxPerDay?: unknown }>(policy.data());
    const count = async (ms: number) => {
      const calls = await this.store
        .collection('toolCalls')
        .where('toolName', '==', toolName)
        .where('status', '==', 'succeeded')
        .where('createdAt', '>=', new Date(now.getTime() - ms))
        .limit(1001)
        .get();
      return calls.size >= 1001 ? Number.POSITIVE_INFINITY : calls.size;
    };
    const hourly = typeof value.maxPerHour === 'number' ? await count(60 * 60_000) : 0;
    const daily = typeof value.maxPerDay === 'number' ? await count(24 * 60 * 60_000) : 0;
    return !(
      (typeof value.maxPerHour === 'number' && hourly >= value.maxPerHour) ||
      (typeof value.maxPerDay === 'number' && daily >= value.maxPerDay)
    );
  }

  async cacheGet(cacheKey: string, now = this.store.now()): Promise<{ result: unknown } | null> {
    const snapshot = await this.store.doc('toolCache', cacheKey).get();
    if (!snapshot.exists) return null;
    const value = decodeRecord<{ expiresAt?: unknown; result?: unknown }>(snapshot.data());
    return value.expiresAt instanceof Date && value.expiresAt >= now
      ? { result: value.result }
      : null;
  }

  async cachePut(input: {
    cacheKey: string;
    toolName: string;
    result: unknown;
    expiresAt: Date;
  }): Promise<void> {
    await this.store.doc('toolCache', input.cacheKey).set(encodeRecord(input), { merge: true });
  }

  async start(
    input: import('@assistant/persistence').StartAutonomousToolCallInput,
  ): Promise<Records['toolCalls'] | null> {
    const id = randomUUID();
    const modelToolCallId = (input.decision as { modelToolCallId?: unknown } | null)
      ?.modelToolCallId;
    const placeholderKeys = toolCallReplayKeysForStart({
      agentId: input.agentId,
      taskId: input.taskId,
      toolCallId: id,
      modelToolCallId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!placeholderKeys) throw new Error('Tool replay identity is invalid');
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const task = read<Records['tasks']>(
        await tx.get(this.store.doc('tasks', input.taskId)),
        input.taskId,
      );
      if (
        !task ||
        task.agentId !== input.agentId ||
        ['done', 'failed', 'cancelled'].includes(task.status)
      )
        return null;
      const keyRefs = placeholderKeys.map((key) => this.store.doc('toolCallReceiptKeys', key.id));
      const existingKeys = keyRefs.length ? await tx.getAll(...keyRefs) : [];
      if (existingKeys.some((snapshot) => snapshot.exists)) return null;
      if (typeof modelToolCallId === 'string') {
        const candidates = await tx.get(
          this.store.collection('toolCalls').where('taskId', '==', input.taskId).limit(501),
        );
        if (candidates.size >= 501) throw new Error('tool call model-id check exceeded bound');
        const duplicate = candidates.docs.some((doc) => {
          const existing = decodeRecord<Records['toolCalls']>(doc.data());
          const decision = existing.decision as { modelToolCallId?: unknown } | null;
          return existing.taskId === input.taskId && decision?.modelToolCallId === modelToolCallId;
        });
        if (duplicate) return null;
      }
      const mapping = input.idempotencyKey
        ? this.store.doc('toolCallIdempotency', input.idempotencyKey)
        : null;
      if (mapping) {
        const existing = await tx.get(mapping);
        if (existing.exists) return null;
      }
      const call = {
        id,
        createdAt: this.store.now(),
        status: 'executing',
        taskId: input.taskId,
        startedAt: input.startedAt ?? this.store.now(),
        step: input.step,
        toolName: input.toolName,
        args: input.args,
        risk: 'autonomous',
        idempotencyKey: input.idempotencyKey,
        result: null,
        error: null,
        approvalId: null,
        decision: input.decision,
        finishedAt: null,
      } as Records['toolCalls'];
      tx.create(this.store.doc('toolCalls', id), encodeRecord(call));
      if (mapping) tx.create(mapping, { toolCallId: id });
      for (const key of toolCallReplayKeysForStart({
        agentId: input.agentId,
        taskId: input.taskId,
        toolCallId: id,
        modelToolCallId,
        idempotencyKey: input.idempotencyKey,
      }) ?? []) {
        tx.create(this.store.doc('toolCallReceiptKeys', key.id), encodeRecord(key));
      }
      return call;
    });
  }

  async findIdempotent(
    agentId: string,
    taskId: string,
    idempotencyKey: string,
  ): Promise<Records['toolCalls'] | null> {
    const mapping = await this.store.doc('toolCallIdempotency', idempotencyKey).get();
    if (!mapping.exists) return null;
    const id = mapping.get('toolCallId');
    if (typeof id !== 'string') throw new Error('Malformed idempotency mapping');
    const call = read<Records['toolCalls']>(await this.store.doc('toolCalls', id).get(), id);
    if (!call) throw new Error('Dangling idempotency mapping');
    return call.taskId === taskId && (await this.load(agentId, taskId, id)) ? call : null;
  }

  async cached(input: CachedToolCallInput): Promise<Records['toolCalls']> {
    const callId = randomUUID();
    const modelToolCallId = (input.decision as { modelToolCallId?: unknown } | null)
      ?.modelToolCallId;
    const placeholderKeys = toolCallReplayKeysForStart({
      agentId: input.agentId,
      taskId: input.taskId,
      toolCallId: callId,
      modelToolCallId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!placeholderKeys) throw new Error('Tool replay identity is invalid');
    return this.store.db.runTransaction(async (tx) => {
      await assertPrivacyErasureInactiveInTransaction(tx, this.store, input.agentId);
      const task = read<Records['tasks']>(
        await tx.get(this.store.doc('tasks', input.taskId)),
        input.taskId,
      );
      if (
        !task ||
        task.agentId !== input.agentId ||
        ['done', 'failed', 'cancelled'].includes(task.status)
      )
        throw new Error('tool call task is not active and owned by agent');
      const keyRefs = placeholderKeys.map((key) => this.store.doc('toolCallReceiptKeys', key.id));
      const existingKeys = keyRefs.length ? await tx.getAll(...keyRefs) : [];
      if (existingKeys.some((snapshot) => snapshot.exists))
        throw new Error('Tool call replay identity is already recorded');
      const mapping = input.idempotencyKey
        ? this.store.doc('toolCallIdempotency', input.idempotencyKey)
        : null;
      if (mapping && (await tx.get(mapping)).exists)
        throw new Error('Tool call idempotency key is already recorded');
      const now = this.store.now();
      const call = {
        id: callId,
        createdAt: now,
        status: 'succeeded',
        taskId: input.taskId,
        startedAt: input.startedAt ?? now,
        step: input.step,
        toolName: input.toolName,
        args: input.args,
        risk: 'autonomous',
        idempotencyKey: input.idempotencyKey,
        result: input.result,
        error: null,
        approvalId: null,
        decision: input.decision,
        finishedAt: now,
      } as Records['toolCalls'];
      tx.create(this.store.doc('toolCalls', call.id), encodeRecord(call));
      if (mapping) tx.create(mapping, { toolCallId: call.id });
      for (const key of toolCallReplayKeysForStart({
        agentId: input.agentId,
        taskId: input.taskId,
        toolCallId: call.id,
        modelToolCallId,
        idempotencyKey: input.idempotencyKey,
      }) ?? []) {
        tx.create(this.store.doc('toolCallReceiptKeys', key.id), encodeRecord(key));
      }
      return call;
    });
  }

  async parentIsMission(agentId: string, parentTaskId: string): Promise<boolean> {
    const task = read<Records['tasks']>(
      await this.store.doc('tasks', parentTaskId).get(),
      parentTaskId,
    );
    return task?.agentId === agentId && task.type === 'mission';
  }

  async conversationGoalId(agentId: string, conversationId: string): Promise<string | null> {
    const snapshot = await this.store.doc('conversations', conversationId).get();
    const conversation = read<Records['conversations']>(snapshot, conversationId);
    const goalId =
      conversation?.agentId === agentId
        ? (conversation.metadata as { goalId?: unknown } | null)?.goalId
        : null;
    return typeof goalId === 'string' ? goalId : null;
  }

  async goalWorkEvidence(agentId: string, taskId: string) {
    const task = read<Records['tasks']>(await this.store.doc('tasks', taskId).get(), taskId);
    if (!task || task.agentId !== agentId) return [];
    const snapshot = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .limit(201)
      .get();
    if (snapshot.size >= 201) throw new Error('Firestore tool evidence scan exceeded bound');
    return snapshot.docs.flatMap((doc) => {
      const value = decodeRecord<Records['toolCalls']>(doc.data());
      const call = documentKey(value.id) === doc.id ? value : null;
      return call ? [{ toolName: call.toolName, status: call.status, result: call.result }] : [];
    });
  }

  async ownerMessageHistory(
    agentId: string,
    conversationId: string,
    before: Date,
  ): Promise<string[]> {
    const conversation = read<Records['conversations']>(
      await this.store.doc('conversations', conversationId).get(),
      conversationId,
    );
    if (
      !conversation ||
      conversation.agentId !== agentId ||
      conversation.channel !== 'chat' ||
      conversation.trust !== 'owner'
    )
      return [];
    const snapshot = await this.store
      .collection('messages')
      .where('conversationId', '==', conversationId)
      .where('role', '==', 'user')
      .where('origin', '==', 'owner')
      .where('createdAt', '<=', before)
      .orderBy('createdAt', 'desc')
      .limit(4)
      .get();
    return snapshot.docs
      .map((doc) => decodeRecord<Records['messages']>(doc.data()))
      .filter((message) => message.createdAt <= before)
      .reverse()
      .map((message) => message.text);
  }

  async searchResults(taskId: string): Promise<unknown[]> {
    const snapshot = await this.store
      .collection('toolCalls')
      .where('taskId', '==', taskId)
      .limit(201)
      .get();
    if (snapshot.size >= 201) throw new Error('Firestore search evidence scan exceeded bound');
    return snapshot.docs.flatMap((doc) => {
      const value = decodeRecord<Records['toolCalls']>(doc.data());
      const call = documentKey(value.id) === doc.id ? value : null;
      return call?.toolName === 'web.search' && call.status === 'succeeded' ? [call.result] : [];
    });
  }
}
