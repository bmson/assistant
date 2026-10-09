import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreApprovalPolicyRepository } from './approval-policies.js';
import { FirestoreApprovalRepository } from './approvals.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore approval policies', () => {
  let store: InstallationStore;
  let policies: FirestoreApprovalPolicyRepository;
  const now = new Date('2026-09-12T12:00:00.000Z');

  beforeEach(() => {
    store = emulatorStore(() => now);
    policies = new FirestoreApprovalPolicyRepository(store);
  });

  afterEach(async () => {
    await disposeStore(store);
  });

  async function seedPolicy(
    agentId: string,
    options: { id?: string; toolName?: string; enabled?: boolean } = {},
  ) {
    const id = options.id ?? randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('approvalPolicies', id).set({
      id,
      agentId,
      toolName: options.toolName ?? 'gmail.send',
      templateKey: 'recipient-domain',
      match: { domain: 'example.com' },
      effect: 'allow',
      enabled: options.enabled ?? true,
      version: 1,
      createdVia: 'approval_dialog',
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function seedApprovalFixture(agentId: string) {
    const taskId = randomUUID();
    const toolCallId = randomUUID();
    const approvalId = randomUUID();
    await store.doc('agents', agentId).set({ id: agentId });
    await store.doc('tasks', taskId).set({
      id: taskId,
      agentId,
      status: 'waiting_approval',
      queueGeneration: 0,
      state: {},
    });
    await store.doc('toolCalls', toolCallId).set({
      id: toolCallId,
      taskId,
      toolName: 'gmail.send',
      status: 'awaiting_approval',
      approvalId,
    });
    await store.doc('approvals', approvalId).set({
      id: approvalId,
      taskId,
      toolCallId,
      status: 'pending',
      requestedAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      shortCode: 'A1ZZ',
      summary: 'policy test',
      payload: { to: 'owner@example.com' },
      resolutionPayload: null,
      resolvedAt: null,
      resolvedVia: null,
      notifiedChannels: [],
      createdPolicyId: null,
    });
    return { taskId, toolCallId, approvalId };
  }

  it('lists only the owner policies with deterministic tool and ID ordering', async () => {
    const owner = 'agent-owner';
    const other = 'agent-other';
    const first = await seedPolicy(owner, { id: 'policy-a', toolName: 'calendar.create_event' });
    const second = await seedPolicy(owner, { id: 'policy-b', toolName: 'gmail.send' });
    await seedPolicy(owner, { id: 'policy-c', toolName: 'gmail.send', enabled: false });
    await seedPolicy(other, { id: 'policy-z', toolName: 'gmail.send' });

    expect((await policies.list(owner)).map((policy) => policy.id)).toEqual([
      first,
      second,
      'policy-c',
    ]);
    expect((await policies.list(owner, { enabledOnly: true })).map((policy) => policy.id)).toEqual([
      first,
      second,
    ]);
    expect(
      (await policies.list(owner, { toolName: 'gmail.send' })).map((policy) => policy.id),
    ).toEqual([second, 'policy-c']);
    expect(await policies.list(other, { toolName: 'calendar.create_event' })).toEqual([]);
  });

  it('scopes enable and delete operations to the owning agent', async () => {
    const owner = 'agent-owner';
    const other = 'agent-other';
    const id = await seedPolicy(owner, { id: 'policy-owner', enabled: true });

    expect(await policies.setEnabled(other, id, false)).toBe(false);
    expect((await store.doc('approvalPolicies', id).get()).get('enabled')).toBe(true);
    expect(await policies.setEnabled(owner, id, false)).toBe(true);
    expect((await store.doc('approvalPolicies', id).get()).get('enabled')).toBe(false);
    expect(await policies.delete(other, id)).toBe(false);
    expect(await policies.delete(owner, id)).toBe(true);
    expect((await store.doc('approvalPolicies', id).get()).exists).toBe(false);
  });

  it('blocks policy enable and delete in their transactions during privacy erasure', async () => {
    const owner = 'agent-erasing';
    const id = await seedPolicy(owner, { id: 'policy-erasure-fence' });
    await store.doc('privacyErasureJobs', owner).set({ agentId: owner, status: 'active' });

    await expect(policies.setEnabled(owner, id, false)).rejects.toThrow(
      'Privacy erasure is in progress',
    );
    await expect(policies.delete(owner, id)).rejects.toThrow('Privacy erasure is in progress');
    expect((await store.doc('approvalPolicies', id).get()).data()).toMatchObject({
      enabled: true,
      agentId: owner,
    });
  });

  it('deletes only verified policy mappings while preserving historical approval IDs', async () => {
    const owner = 'agent-owner';
    const policyId = await seedPolicy(owner, { id: 'policy-delete' });
    const preservedPolicy = await seedPolicy(owner, { id: 'policy-preserve' });
    await store.doc('approvalPolicyKeys', 'key-delete').set({ policyId });
    await store.doc('approvalPolicyKeys', 'key-preserve').set({ policyId: preservedPolicy });
    const fixture = await seedApprovalFixture(owner);
    await store.doc('approvals', fixture.approvalId).update({ createdPolicyId: policyId });

    expect(await policies.delete(owner, policyId)).toBe(true);
    expect((await store.doc('approvalPolicyKeys', 'key-delete').get()).exists).toBe(false);
    expect((await store.doc('approvalPolicyKeys', 'key-preserve').get()).exists).toBe(true);
    expect((await store.doc('approvals', fixture.approvalId).get()).get('createdPolicyId')).toBe(
      policyId,
    );
  });

  it('recreates a clean policy mapping when approval resolution follows deletion', async () => {
    const owner = 'agent-owner';
    const oldPolicy = await seedPolicy(owner, { id: 'policy-old' });
    await store.doc('approvalPolicyKeys', 'old-key').set({ policyId: oldPolicy });
    const fixture = await seedApprovalFixture(owner);
    expect(await policies.delete(owner, oldPolicy)).toBe(true);

    const resolution = await new FirestoreApprovalRepository(store).resolve({
      approvalId: fixture.approvalId,
      decision: 'approved',
      via: 'web',
      policy: {
        agentId: owner,
        toolName: 'gmail.send',
        templateKey: 'recipient-domain',
        match: { domain: 'example.com' },
        effect: 'allow',
      },
    });
    expect(resolution.ok).toBe(true);
    const mappings = await store.collection('approvalPolicyKeys').get();
    const createdPolicies = await store.collection('approvalPolicies').get();
    expect(mappings.size).toBe(1);
    expect(createdPolicies.size).toBe(1);
    expect(mappings.docs[0]?.get('policyId')).toBe(createdPolicies.docs[0]?.get('id'));
  });

  it('keeps concurrent resolve and delete mappings coherent', async () => {
    const owner = 'agent-owner';
    const oldPolicy = await seedPolicy(owner, { id: 'policy-race' });
    const fixture = await seedApprovalFixture(owner);
    const policyInput = {
      agentId: owner,
      toolName: 'gmail.send',
      templateKey: 'recipient-domain',
      match: { domain: 'example.com' },
      effect: 'allow' as const,
    };
    await store.doc('approvalPolicyKeys', 'race-key').set({ policyId: oldPolicy });

    await Promise.all([
      policies.delete(owner, oldPolicy),
      new FirestoreApprovalRepository(store).resolve({
        approvalId: fixture.approvalId,
        decision: 'approved',
        via: 'web',
        policy: policyInput,
      }),
    ]);
    const mappings = await store.collection('approvalPolicyKeys').get();
    for (const mapping of mappings.docs) {
      const policy = await store.doc('approvalPolicies', String(mapping.get('policyId'))).get();
      expect(policy.exists).toBe(true);
    }
  });
});
