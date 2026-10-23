import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticAccounting,
  buildDiagnosticInterruptedReceipt,
} from './calendar-diagnostic-accounting.js';

describe('calendar diagnostic accounting receipt', () => {
  it('keeps provider-reported charges, estimates, and settled reservations distinct', () => {
    const reported = { basis: 'provider_reported', provider: 'synthetic-provider' };
    const estimate = { basis: 'preflight_estimate', source: 'synthetic-estimator' };
    const input = {
      routerInvocations: 2,
      modelRows: [
        { inputTokens: 12, outputTokens: 7, costUsd: '0.002' },
        { inputTokens: 5, outputTokens: 3, costUsd: '0.001' },
      ],
      costRows: [
        { usd: '0.002', evidence: reported },
        { usd: '0.001', evidence: estimate },
      ],
      reservations: [
        { status: 'reconciled', estimatedUsd: '0.004', actualUsd: '0.003', unknownReason: null },
        { status: 'released', estimatedUsd: '0.001', actualUsd: null, unknownReason: null },
      ],
    };

    const receipt = buildDiagnosticAccounting(input);

    expect(receipt).toMatchObject({
      status: 'incomplete',
      chargeOutcome: 'unknown',
      routerInvocations: 2,
      modelLedgerRows: 2,
      recordedInputTokens: 17,
      recordedOutputTokens: 10,
      costEvidence: [reported, estimate],
      reservations: input.reservations,
    });
    expect(receipt.missing).toContain(
      'router traces and model ledger rows cannot be mapped one-to-one; preflight calls and retries make counts inconclusive',
    );
    expect(receipt.limitation).toContain('one-to-one coverage');
    expect(receipt.costEvidence[0]).toMatchObject({ basis: 'provider_reported' });
    expect(receipt.costEvidence[1]).toMatchObject({ basis: 'preflight_estimate' });
  });

  it('marks failures and unknown attempt charges incomplete instead of free', () => {
    const receipt = buildDiagnosticAccounting({
      routerInvocations: 1,
      modelRows: [],
      costRows: [{ usd: '0', evidence: { basis: 'unknown', reason: 'synthetic timeout' } }],
      reservations: [
        {
          status: 'unknown',
          estimatedUsd: '0.01',
          actualUsd: null,
          unknownReason: 'synthetic timeout',
        },
      ],
    });

    expect(receipt.status).toBe('incomplete');
    expect(receipt.missing).toEqual(
      expect.arrayContaining([
        'model cost ledger absent for observed router work',
        'unknown cost evidence',
        'unsettled cost reservation',
      ]),
    );
  });

  it('distinguishes no work from ambiguous zero-default ledger values', () => {
    expect(
      buildDiagnosticAccounting({
        routerInvocations: 0,
        modelRows: [],
        costRows: [],
        reservations: [],
      }).status,
    ).toBe('not-applicable');

    const ambiguous = buildDiagnosticAccounting({
      routerInvocations: 1,
      modelRows: [{ inputTokens: 0, outputTokens: 0, costUsd: '0' }],
      costRows: [],
      reservations: [],
    });
    expect(ambiguous.status).toBe('incomplete');
    expect(ambiguous.missing).toContain(
      'zero token ledger values may represent missing provider usage',
    );
  });

  it('rejects missing positive-cost evidence, malformed values, and unsettled cancellation rows', () => {
    const receipt = buildDiagnosticAccounting({
      routerInvocations: 1,
      modelRows: [{ inputTokens: 4, outputTokens: 2, costUsd: '0.4' }],
      costRows: [],
      reservations: [
        { status: 'dispatching', estimatedUsd: '0.5', actualUsd: null, unknownReason: null },
        { status: 'reconciled', estimatedUsd: 'NaN', actualUsd: '-1', unknownReason: null },
      ],
    });
    expect(receipt.status).toBe('incomplete');
    expect(receipt.missing).toEqual(
      expect.arrayContaining([
        'positive model cost has no cost evidence row',
        'unsettled cost reservation',
        'reservation has malformed or negative estimate',
        'reservation has malformed or negative actual charge',
      ]),
    );
  });

  it('copies reservation rows without mutating the caller input', () => {
    const reservation = {
      status: 'released',
      estimatedUsd: '0.01',
      actualUsd: null,
      unknownReason: 'cancelled before send',
    };
    const input = {
      routerInvocations: 0,
      modelRows: [],
      costRows: [],
      reservations: [reservation],
    };
    const receipt = buildDiagnosticAccounting(input);
    expect(receipt.reservations).not.toBe(input.reservations);
    expect(receipt.reservations[0]).not.toBe(reservation);
    expect(reservation).toEqual({
      status: 'released',
      estimatedUsd: '0.01',
      actualUsd: null,
      unknownReason: 'cancelled before send',
    });
  });

  it('marks partial ledger rows incomplete and explains why even equal counts are ambiguous', () => {
    const partial = buildDiagnosticAccounting({
      routerInvocations: 2,
      modelRows: [{ inputTokens: 10, outputTokens: 4, costUsd: '0.02' }],
      costRows: [{ usd: '0.02', evidence: { basis: 'provider_reported' } }],
      reservations: [],
    });
    expect(partial.status).toBe('incomplete');
    expect(partial.chargeOutcome).toBe('unknown');
    expect(partial.missing).toContain(
      'router traces and model ledger rows cannot be mapped one-to-one; preflight calls and retries make counts inconclusive',
    );

    const equalCounts = buildDiagnosticAccounting({
      routerInvocations: 1,
      modelRows: [{ inputTokens: 10, outputTokens: 4, costUsd: '0.02' }],
      costRows: [{ usd: '0.02', evidence: { basis: 'provider_reported' } }],
      reservations: [],
    });
    expect(equalCounts.status).toBe('incomplete');
    expect(equalCounts.limitation).toBe(partial.limitation);
    expect(equalCounts.missing).toContain(
      'router traces and model ledger rows cannot be mapped one-to-one; preflight calls and retries make counts inconclusive',
    );
  });

  it('creates a stop receipt for thrown or aborted runs without leaking raw error text or zeroing charges', () => {
    const receipt = buildDiagnosticInterruptedReceipt(
      'synthetic-case',
      new Error('provider secret response body'),
    );
    expect(receipt).toEqual({
      caseId: 'synthetic-case',
      status: 'interrupted',
      errorName: 'Error',
      accounting: {
        status: 'incomplete',
        chargeOutcome: 'unknown',
        missing: ['execution interrupted; provider charge outcome is unknown'],
      },
      modelCalls: null,
      tokens: null,
      costUsd: null,
      stopFollowingCases: true,
    });
    expect(JSON.stringify(receipt)).not.toContain('provider secret response body');
    expect(
      buildDiagnosticInterruptedReceipt('synthetic-case', { name: 'secret provider payload' })
        .errorName,
    ).toBe('Error');
  });

  it('marks persisted accounting unverified when execution ends with an error', () => {
    const receipt = buildDiagnosticAccounting({
      routerInvocations: 1,
      modelRows: [{ inputTokens: 10, outputTokens: 4, costUsd: '0.02' }],
      costRows: [{ usd: '0.02', evidence: { basis: 'provider_reported' } }],
      reservations: [],
      executionError: 'synthetic abort',
    });
    expect(receipt.status).toBe('incomplete');
    expect(receipt.chargeOutcome).toBe('unknown');
    expect(receipt.missing).toContain(
      'execution ended with an error; provider charge outcome is unverified',
    );
  });
});
