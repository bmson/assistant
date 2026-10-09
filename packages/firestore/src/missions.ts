import { randomUUID } from 'node:crypto';
import {
  addMicros,
  type MissionProgressRepository,
  type MissionReport,
  type MissionReportLeg,
  type MissionReportLegStatus,
  type MissionReportTransitionInput,
  type MissionRepository,
  type MissionSessionProgressInput,
  microsToUsd,
  type Records,
  usdToMicros,
} from '@assistant/persistence';
import type { DocumentSnapshot } from '@google-cloud/firestore';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

type Task = Records['tasks'];

const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'cancelled']);
/** A mission wakes about daily, so this is well past a long mission's sessions. */
const MAX_MISSION_SESSIONS = 500;
const MAX_MISSION_DESCENDANTS = 2_000;

function ownedTask(snapshot: DocumentSnapshot, agentId: string): Task | null {
  if (!snapshot.exists) return null;
  const row = decodeRecord<Task>(snapshot.data());
  if (documentKey(row.id) !== snapshot.id || row.agentId !== agentId) return null;
  return row;
}

/** Mission wake reads and the mission.update session write. */
export class FirestoreMissionRepository implements MissionRepository, MissionProgressRepository {
  readonly kind = 'mission-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  private assertOwner(agentId: string) {
    if (!this.configuredAgentId || agentId !== this.configuredAgentId)
      throw new Error('Mission is outside the configured installation');
  }

  private async sessions(agentId: string, missionId: string): Promise<Task[]> {
    this.assertOwner(agentId);
    const snapshot = await this.store
      .collection('tasks')
      .where('parentTaskId', '==', missionId)
      .limit(MAX_MISSION_SESSIONS + 1)
      .get();
    if (snapshot.size > MAX_MISSION_SESSIONS)
      throw new Error('Too many mission sessions to read safely');
    return snapshot.docs.map((doc) => {
      const row = decodeRecord<Task>(doc.data());
      if (
        documentKey(row.id) !== doc.id ||
        row.agentId !== agentId ||
        row.parentTaskId !== missionId
      )
        throw new Error('Mission session identity mismatch');
      return row;
    });
  }

  private async descendants(agentId: string, rootId: string): Promise<Task[]> {
    this.assertOwner(agentId);
    const queue = [rootId];
    const visitedParents = new Set<string>(queue);
    const descendants: Task[] = [];
    while (queue.length > 0) {
      const parentId = queue.shift();
      if (!parentId) continue;
      const remaining = MAX_MISSION_DESCENDANTS - descendants.length;
      const snapshot = await this.store
        .collection('tasks')
        .where('parentTaskId', '==', parentId)
        .limit(remaining + 1)
        .get();
      if (snapshot.size > remaining)
        throw new Error('Too many mission descendants to account for safely');
      for (const doc of snapshot.docs) {
        const row = decodeRecord<Task>(doc.data());
        if (
          documentKey(row.id) !== doc.id ||
          row.agentId !== agentId ||
          row.parentTaskId !== parentId
        ) {
          throw new Error('Mission descendant identity mismatch');
        }
        if (visitedParents.has(row.id)) continue;
        visitedParents.add(row.id);
        descendants.push(row);
        queue.push(row.id);
      }
    }
    return descendants;
  }

  async activeSession(agentId: string, missionId: string) {
    const active = (await this.sessions(agentId, missionId))
      .filter((task) => !TERMINAL_TASK_STATUSES.has(task.status))
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id),
      )[0];
    return active ? { id: active.id, status: active.status } : null;
  }

  async spentUsd(agentId: string, missionId: string) {
    const [mission, sessions] = await Promise.all([
      this.store.doc('tasks', missionId).get(),
      this.descendants(agentId, missionId),
    ]);
    const row = ownedTask(mission, agentId);
    if (row?.type !== 'mission')
      throw new Error('Mission not found or outside the configured installation');
    return microsToUsd(
      addMicros(
        ...[...(row ? [row] : []), ...sessions].map((task) => usdToMicros(Number(task.spentUsd))),
      ),
    );
  }

  async transitionWithReport(input: MissionReportTransitionInput) {
    this.assertOwner(input.agentId);
    if (!input.eventId.startsWith(`mission:${input.taskId}:`))
      throw new Error('Mission report identity is not bound to its task');
    return this.store.db.runTransaction(async (tx) => {
      const taskRef = this.store.doc('tasks', input.taskId);
      const task = ownedTask(await tx.get(taskRef), input.agentId);
      if (
        task?.type !== 'mission' ||
        task.status !== 'running' ||
        task.leaseToken !== input.leaseToken
      )
        return false;
      const reportRef = this.store.doc('missionReports', input.eventId);
      const existing = await tx.get(reportRef);
      const report: MissionReport = {
        id: input.eventId,
        agentId: task.agentId,
        missionId: task.id,
        goalId: task.goalId,
        conversationId: task.conversationId,
        outcome: input.outcome,
        text: input.text,
        chatStatus: 'pending',
        ownerStatus: 'pending',
        mirrorStatus: 'pending',
        claimToken: null,
        lockedUntil: null,
        nextAttemptAt: this.store.now(),
        attempts: 0,
        createdAt: this.store.now(),
        updatedAt: this.store.now(),
        chatDeliveredAt: null,
        ownerDeliveredAt: null,
        mirrorDeliveredAt: null,
        lastError: null,
      };
      tx.update(
        taskRef,
        encodeRecord({
          status: input.status,
          progress: input.progress ?? task.progress,
          ...(input.progressPercent !== undefined
            ? { progressPercent: input.progressPercent }
            : {}),
          ...(input.lastReflectedAt ? { lastReflectedAt: input.lastReflectedAt } : {}),
          lockedUntil: null,
          leaseToken: null,
          runAfter: null,
          attempt: 0,
          ...(input.status === 'needs_attention' || input.status === 'waiting_event'
            ? { attentionNotifiedAt: null }
            : {}),
          updatedAt: this.store.now(),
        }),
      );
      if (!existing.exists) tx.create(reportRef, encodeRecord(report));
      return true;
    });
  }

  async dueReports(agentId: string, limit = 20) {
    this.assertOwner(agentId);
    const snapshot = await this.store
      .collection('missionReports')
      .where('nextAttemptAt', '<=', this.store.now())
      .limit(Math.max(1, Math.min(limit * 4, 400)))
      .get();
    return snapshot.docs
      .map((doc) => ({ documentId: doc.id, report: decodeRecord<MissionReport>(doc.data()) }))
      .filter(
        ({ documentId, report }) =>
          documentKey(report.id) === documentId && report.agentId === agentId,
      )
      .filter(({ report }) => !report.lockedUntil || report.lockedUntil <= this.store.now())
      .filter(
        ({ report }) =>
          report.chatStatus === 'pending' ||
          report.chatStatus === 'failed' ||
          report.ownerStatus === 'pending' ||
          report.ownerStatus === 'failed' ||
          report.mirrorStatus === 'pending' ||
          report.mirrorStatus === 'failed',
      )
      .sort((a, b) => a.report.nextAttemptAt.getTime() - b.report.nextAttemptAt.getTime())
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map(({ report }) => report.id);
  }

  async claimReport(id: string, agentId: string, leaseMs = 30_000) {
    const claimToken = randomUUID();
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('missionReports', id);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      const report = decodeRecord<MissionReport>(snapshot.data());
      if (report.id !== id) throw new Error('Mission report identity mismatch');
      this.assertOwner(agentId);
      if (report.agentId !== agentId) return null;
      const now = this.store.now();
      const pending =
        report.chatStatus === 'pending' ||
        report.chatStatus === 'failed' ||
        report.ownerStatus === 'pending' ||
        report.ownerStatus === 'failed' ||
        report.mirrorStatus === 'pending' ||
        report.mirrorStatus === 'failed';
      if (
        !pending ||
        report.nextAttemptAt > now ||
        (report.lockedUntil && report.lockedUntil > now)
      )
        return null;
      const claimed: MissionReport = {
        ...report,
        claimToken,
        lockedUntil: new Date(now.getTime() + Math.max(1_000, Math.min(leaseMs, 120_000))),
        attempts: report.attempts + 1,
        updatedAt: now,
      };
      tx.update(ref, encodeRecord(claimed));
      return { report: claimed, claimToken };
    });
  }

  async settleReportLeg(input: {
    id: string;
    claimToken: string;
    leg: MissionReportLeg;
    status: MissionReportLegStatus;
    error?: string;
  }) {
    if (input.leg !== 'owner' && input.status === 'unknown')
      throw new Error('Only owner report leg can have unknown status');
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('missionReports', input.id);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const report = decodeRecord<MissionReport>(snapshot.data());
      this.assertOwner(report.agentId);
      const now = this.store.now();
      if (
        report.claimToken !== input.claimToken ||
        !report.lockedUntil ||
        report.lockedUntil <= now
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          ...(input.leg === 'chat'
            ? {
                chatStatus: input.status,
                ...(input.status === 'delivered' ? { chatDeliveredAt: now } : {}),
              }
            : input.leg === 'owner'
              ? {
                  ownerStatus: input.status,
                  ...(input.status === 'delivered' ? { ownerDeliveredAt: now } : {}),
                }
              : {
                  mirrorStatus: input.status,
                  ...(input.status === 'delivered' ? { mirrorDeliveredAt: now } : {}),
                }),
          lastError: input.error?.slice(0, 500) ?? null,
          updatedAt: now,
        }),
      );
      return true;
    });
  }

  async releaseReport(input: { id: string; claimToken: string; error?: string }) {
    return this.store.db.runTransaction(async (tx) => {
      const ref = this.store.doc('missionReports', input.id);
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return false;
      const report = decodeRecord<MissionReport>(snapshot.data());
      this.assertOwner(report.agentId);
      const now = this.store.now();
      if (
        report.claimToken !== input.claimToken ||
        !report.lockedUntil ||
        report.lockedUntil <= now
      )
        return false;
      tx.update(
        ref,
        encodeRecord({
          claimToken: null,
          lockedUntil: null,
          nextAttemptAt: new Date(
            now.getTime() + Math.min(300_000, 5_000 * 2 ** Math.min(report.attempts, 6)),
          ),
          lastError: input.error?.slice(0, 500) ?? report.lastError,
          updatedAt: now,
        }),
      );
      return true;
    });
  }

  async recordSessionProgress(input: MissionSessionProgressInput) {
    this.assertOwner(input.agentId);
    if (
      input.progress.length < 3 ||
      input.progress.length > 1000 ||
      input.nextAction.length > 500 ||
      input.notes.length > 2000
    )
      throw new Error('Invalid mission progress');
    return this.store.db.runTransaction(async (tx) => {
      const session = ownedTask(
        await tx.get(this.store.doc('tasks', input.sessionTaskId)),
        input.agentId,
      );
      if (!session?.parentTaskId) throw new Error('this task has no parent mission');
      const missionRef = this.store.doc('tasks', session.parentTaskId);
      const mission = ownedTask(await tx.get(missionRef), input.agentId);
      if (mission?.type !== 'mission') throw new Error('parent is not a mission');
      const state =
        mission.state && typeof mission.state === 'object' && !Array.isArray(mission.state)
          ? { ...(mission.state as Record<string, unknown>) }
          : {};
      if (input.notes) state.scratchpad = input.notes.slice(0, 4000);
      tx.update(
        missionRef,
        encodeRecord({
          progress: input.progress,
          nextAction: input.nextAction,
          progressPercent: input.progressPercent ?? mission.progressPercent,
          state,
          updatedAt: this.store.now(),
        }),
      );
      return { updated: mission.id };
    });
  }
}
