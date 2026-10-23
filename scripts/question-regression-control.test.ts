import { describe, expect, it, vi } from 'vitest';
import {
  captureDiagnosticCase,
  decideDiagnosticRunControl,
} from './question-regression-control.js';

describe('question regression run control', () => {
  it('exits nonzero for a final incomplete result even when no later case is skipped', () => {
    const control = decideDiagnosticRunControl({
      fixtureIds: ['only-case'],
      completed: [{ id: 'only-case', failures: [], accountingStatus: 'incomplete' }],
      live: true,
      remainingBudgetUsd: 4,
      cleanupFailed: false,
    });

    expect(control).toMatchObject({
      notRun: [],
      stopReason: 'prior_case_accounting_incomplete',
      accountingComplete: false,
      chargeOutcome: 'unknown',
      exitCode: 1,
    });
  });

  it('stops after an incomplete result and gives every later case the precise reason', () => {
    const control = decideDiagnosticRunControl({
      fixtureIds: ['first', 'incomplete', 'later-a', 'later-b'],
      completed: [
        { id: 'first', failures: [], accountingStatus: 'complete' },
        { id: 'incomplete', failures: [], accountingStatus: 'incomplete' },
      ],
      live: true,
      remainingBudgetUsd: 3,
      cleanupFailed: false,
    });

    expect(control.notRun).toEqual(['later-a', 'later-b']);
    expect(control.notRunReasons).toEqual({
      'later-a': 'prior_case_accounting_incomplete',
      'later-b': 'prior_case_accounting_incomplete',
    });
    expect(control.exitCode).toBe(1);
  });

  it.each(['Error', 'AbortError'])('captures %s without leaking its message', async (errorName) => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('synthetic secret abort details'), { name: errorName });
    });
    const captured = await captureDiagnosticCase('current', run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(captured.result).toBeNull();
    expect(captured.interrupted).toMatchObject({
      caseId: 'current',
      status: 'interrupted',
      errorName,
      accounting: { status: 'incomplete', chargeOutcome: 'unknown' },
      modelCalls: null,
      tokens: null,
      costUsd: null,
      stopFollowingCases: true,
    });
    expect(JSON.stringify(captured.interrupted)).not.toContain('synthetic secret abort details');
  });

  it('does not run the next callback after an incomplete case', async () => {
    const calls: string[] = [];
    const completed: {
      id: string;
      failures: string[];
      accountingStatus: 'complete' | 'incomplete';
    }[] = [];
    const runCase = vi.fn(async (id: string) => {
      calls.push(id);
      return { id, failures: [], accountingStatus: 'incomplete' as const };
    });

    const first = await runCase('first');
    completed.push(first);
    const control = decideDiagnosticRunControl({
      fixtureIds: ['first', 'next'],
      completed,
      live: true,
      remainingBudgetUsd: 3,
      cleanupFailed: false,
    });
    if (!control.notRun.includes('next')) await runCase('next');

    expect(calls).toEqual(['first']);
    expect(runCase).toHaveBeenCalledTimes(1);
    expect(control.notRunReasons.next).toBe('prior_case_accounting_incomplete');
  });

  it('serializes an interrupted partial summary and stops later callbacks despite cleanup failure', async () => {
    const calls: string[] = [];
    const runCase = vi.fn(async (id: string) => {
      calls.push(id);
      if (id === 'current')
        throw Object.assign(new Error('secret abort body'), { name: 'AbortError' });
      return { id, failures: [], accountingStatus: 'complete' as const };
    });
    const completed = [await runCase('prior')];
    const captured = await captureDiagnosticCase('current', () => runCase('current'));
    const interrupted = captured.interrupted;
    const control = decideDiagnosticRunControl({
      fixtureIds: ['prior', 'current', 'later'],
      completed,
      interrupted,
      live: true,
      remainingBudgetUsd: 3,
      cleanupFailed: true,
    });
    if (!interrupted && !control.notRun.includes('later')) await runCase('later');

    const summary = JSON.parse(
      JSON.stringify({
        completed,
        interruptedCases: interrupted ? [interrupted] : [],
        notRun: control.notRun,
        notRunReasons: control.notRunReasons,
        chargeOutcome: control.chargeOutcome,
        cleanupFailed: control.cleanupFailed,
        accountingComplete: control.accountingComplete,
        exitCode: control.exitCode,
      }),
    );
    expect(calls).toEqual(['prior', 'current']);
    expect(summary.notRun).toEqual(['later']);
    expect(summary.notRunReasons.later).toBe('prior_case_interrupted_charge_unknown');
    expect(summary.interruptedCases[0]).toMatchObject({
      errorName: 'AbortError',
      accounting: { status: 'incomplete', chargeOutcome: 'unknown' },
      modelCalls: null,
      tokens: null,
      costUsd: null,
      stopFollowingCases: true,
    });
    expect(summary).toMatchObject({
      chargeOutcome: 'unknown',
      cleanupFailed: true,
      accountingComplete: false,
      exitCode: 1,
    });
    expect(JSON.stringify(summary)).not.toContain('secret abort body');
  });

  it('does not call accounting complete for a healthy but partial prefix', () => {
    const control = decideDiagnosticRunControl({
      fixtureIds: ['done', 'not-yet-run'],
      completed: [{ id: 'done', failures: [], accountingStatus: 'complete' }],
      live: true,
      remainingBudgetUsd: 3,
      cleanupFailed: false,
    });
    expect(control.accountingComplete).toBe(false);
  });

  it('applies the live preflight floor precisely without charging or running skipped cases', () => {
    const atFloor = decideDiagnosticRunControl({
      fixtureIds: ['next'],
      completed: [],
      live: true,
      remainingBudgetUsd: 0.1,
      cleanupFailed: false,
    });
    expect(atFloor.notRun).toEqual([]);
    expect(atFloor.stopReason).toBeNull();

    const belowFloor = decideDiagnosticRunControl({
      fixtureIds: ['next', 'after'],
      completed: [],
      live: true,
      remainingBudgetUsd: 0.0999,
      cleanupFailed: false,
    });
    expect(belowFloor.notRun).toEqual(['next', 'after']);
    expect(belowFloor.notRunReasons).toEqual({
      next: 'remaining_budget_below_0.10_usd_preflight_floor',
      after: 'remaining_budget_below_0.10_usd_preflight_floor',
    });
    expect(belowFloor.exitCode).toBe(1);
  });

  it('preserves incomplete accounting and nonzero exit when cleanup also fails', () => {
    const control = decideDiagnosticRunControl({
      fixtureIds: ['case'],
      completed: [{ id: 'case', failures: [], accountingStatus: 'incomplete' }],
      live: false,
      remainingBudgetUsd: 5,
      cleanupFailed: true,
    });
    expect(control).toMatchObject({
      accountingComplete: false,
      chargeOutcome: 'unknown',
      cleanupFailed: true,
      exitCode: 1,
    });
  });

  it('keeps completed failure evidence in the final exit policy', () => {
    const control = decideDiagnosticRunControl({
      fixtureIds: ['case'],
      completed: [
        { id: 'case', failures: ['synthetic assertion failed'], accountingStatus: 'complete' },
      ],
      live: false,
      remainingBudgetUsd: 5,
      cleanupFailed: false,
    });
    expect(control.exitCode).toBe(1);
    expect(control.accountingComplete).toBe(true);
  });
});
