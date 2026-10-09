import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DispatcherPort } from '@assistant/core';
import type { ScheduleRecord, ScheduleRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import {
  allowlistedGoalSessionDispatcher,
  GoalSessionEvidence,
  goalSessionMode,
  goalSessionToolAllowlist,
  scopedGoalScheduleRepository,
  verifyGoalSessionEvidence,
} from './goal-session-safety.js';

describe('goal rehearsal isolation', () => {
  it('requires a safe plan or the separately armed metered mode', () => {
    expect(goalSessionMode(['--plan'], undefined)).toBe('plan');
    expect(() => goalSessionMode([], '1')).toThrow('exactly one');
    expect(() => goalSessionMode(['--plan', '--metered-live'], '1')).toThrow('exactly one');
    expect(() => goalSessionMode(['--metered-live'], undefined)).toThrow('requires');
    expect(goalSessionMode(['--metered-live'], '1')).toBe('metered-live');
    expect(goalSessionMode(['--reconcile-orphans'], undefined)).toBe('reconcile-orphans');
  });

  it('limits scheduled reads and commits to the one selected schedule', async () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const target = {
      id: 'target',
      agentId: 'owner',
      enabled: true,
      nextRunAt: new Date(now.getTime() - 1),
    } as unknown as ScheduleRecord;
    const baseMocks = {
      kind: 'schedule-repository',
      listUninitialized: vi.fn(async () => [{ id: 'unrelated' }]),
      listDue: vi.fn(async () => [{ id: 'unrelated' }]),
      listPage: vi.fn(),
      ensure: vi.fn(),
      getByName: vi.fn(),
      setOwnerEnabled: vi.fn(),
      initialize: vi.fn(),
      commitOccurrence: vi.fn(),
    };
    const base = baseMocks as unknown as ScheduleRepository;
    const scoped = scopedGoalScheduleRepository(
      base,
      { agentId: 'owner', scheduleId: 'target' },
      async () => target,
    );
    expect(await scoped.listUninitialized(100)).toEqual([]);
    expect(await scoped.listDue(now, 100)).toEqual([target]);
    expect(baseMocks.listUninitialized).not.toHaveBeenCalled();
    expect(baseMocks.listDue).not.toHaveBeenCalled();

    const mismatched = scopedGoalScheduleRepository(
      base,
      { agentId: 'owner', scheduleId: 'target' },
      async () => ({ ...target, id: 'other' }),
    );
    expect(await mismatched.listDue(now, 1)).toEqual([]);
  });

  it('requires an explicit allowlist and rejects private or effectful tools', () => {
    const registry = [
      { tool: { name: 'weather.lookup', risk: 'autonomous' }, flags: { networkEgress: true } },
      { tool: { name: 'mail.send', risk: 'autonomous' }, flags: { outwardFacing: true } },
      { tool: { name: 'memory.search', risk: 'autonomous' }, flags: { confidentialRead: true } },
      {
        tool: { name: 'internal.sweep', risk: 'autonomous' },
        flags: { internalEventKind: 'sweep' },
      },
      { tool: { name: 'calendar.write', risk: () => 'approval' }, flags: {} },
    ] as never;
    expect(() => goalSessionToolAllowlist(undefined, registry)).toThrow('explicitly');
    expect(goalSessionToolAllowlist('weather.lookup', registry)).toEqual(
      new Set(['weather.lookup']),
    );
    for (const unsafe of ['mail.send', 'memory.search', 'internal.sweep', 'calendar.write'])
      expect(() => goalSessionToolAllowlist(unsafe, registry)).toThrow('non-read-only');
    expect(() => goalSessionToolAllowlist('missing.tool', registry)).toThrow('unavailable');
    expect(() => goalSessionToolAllowlist('weather.lookup,weather.lookup', registry)).toThrow(
      'duplicate',
    );
  });

  it('filters model-visible tools and rejects dispatch and approval outside the allowlist', async () => {
    const dispatcherMocks = {
      toolDefs: vi.fn(() => [
        { name: 'weather.lookup', description: 'read weather', inputSchema: {} },
        { name: 'mail.send', description: 'send mail', inputSchema: {} },
      ]),
      resultIsUntrusted: vi.fn(() => false),
      dispatch: vi.fn(async () => ({
        kind: 'executed' as const,
        toolCallId: 'call',
        result: {},
        cached: false,
      })),
      executeApproved: vi.fn(async () => ({ kind: 'executed' as const, result: {} })),
    };
    const dispatcher = dispatcherMocks as unknown as DispatcherPort;
    const scoped = allowlistedGoalSessionDispatcher(dispatcher, new Set(['weather.lookup']));
    expect(scoped.toolDefs('owner').map((tool) => tool.name)).toEqual(['weather.lookup']);
    expect(await scoped.dispatch({ toolName: 'mail.send' } as never)).toMatchObject({
      kind: 'rejected',
    });
    expect(dispatcherMocks.dispatch).not.toHaveBeenCalled();
    expect(await scoped.executeApproved('call', {} as never)).toMatchObject({ kind: 'failed' });
    expect(dispatcherMocks.executeApproved).not.toHaveBeenCalled();
    expect(await scoped.dispatch({ toolName: 'weather.lookup' } as never)).toMatchObject({
      kind: 'executed',
    });
  });

  it('retains append-only owner-private run, usage, and cleanup evidence', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'goal-session-evidence-'));
    const runId = '01234567-89ab-cdef-0123-456789abcdef';
    try {
      const evidence = await GoalSessionEvidence.create(
        parent,
        runId,
        () => new Date('2026-10-07T12:00:00Z'),
      );
      await evidence.record({ event: 'fixture_created', runId, goalId: 'synthetic-goal' });
      await evidence.record({
        event: 'usage_ledger_retained',
        runId,
        totalUsd: '0.012300',
        rehearsal: false,
      });
      await evidence.record({ event: 'fixture_cleanup_complete', runId });
      const files = (await readdir(evidence.directory)).sort();
      expect(files).toEqual(['000001.json', '000002.json', '000003.json']);
      const usageFile = files[1];
      if (!usageFile) throw new Error('usage evidence file was not written');
      expect(
        JSON.parse(await readFile(path.join(evidence.directory, usageFile), 'utf8')),
      ).toMatchObject({
        rehearsal: true,
        event: 'usage_ledger_retained',
      });
      expect((await stat(path.join(evidence.directory, usageFile))).mode & 0o777).toBe(0o600);
      await expect(
        evidence.record({ event: 'fixture_created', runId, goalId: 'overwrite' }),
      ).resolves.toBeTruthy();
      expect((await readdir(evidence.directory)).length).toBe(4);
      expect(await verifyGoalSessionEvidence(evidence.directory)).toBe(true);
      await writeFile(path.join(evidence.directory, usageFile), '{"edited":true}\n');
      expect(await verifyGoalSessionEvidence(evidence.directory)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
