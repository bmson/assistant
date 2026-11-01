import {
  billingCoverageProjection,
  type ProviderBilling,
} from '@assistant/application/provider-billing';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BillingCoverageSummary, ProviderBillingCards } from './provider-billing-cards';

const report: ProviderBilling = {
  id: 'google-cloud',
  label: 'Google Cloud',
  status: 'not_configured',
  period: '2026-09',
  scope: 'Project: assistant',
  source: 'Cloud Billing export',
  message: 'Export is not connected.',
  fetchedAt: null,
  latestExportAt: null,
  latestUsageAt: null,
  lines: [],
};

describe('provider billing presentation', () => {
  it('renders OpenRouter amount-only values as reported cost without invented credits or net', () => {
    const html = renderToStaticMarkup(
      <ProviderBillingCards
        reports={[
          {
            ...report,
            id: 'openrouter',
            label: 'OpenRouter',
            status: 'reported',
            amountBasis: 'provider_reported_cost',
            fetchedAt: '2026-09-27T12:00:00Z',
            message: 'Spend reported for the connected API key.',
            lines: [
              {
                service: 'OpenRouter',
                detail: 'Current API key · month to date',
                currency: 'USD',
                cost: 12,
                credits: 0,
                net: 12,
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('Reported cost');
    expect(html).toContain('$12.00');
    expect(html).toContain('Not reported');
    expect(html).not.toContain('Credits: $0.00');
  });

  it('labels selected OpenAI amount as reported cost without inventing credits, net or freshness', () => {
    const html = renderToStaticMarkup(
      <ProviderBillingCards
        reports={[
          {
            ...report,
            id: 'openai-billing',
            label: 'OpenAI organization',
            status: 'reported',
            periodTimezone: 'UTC',
            checkedAt: '2026-09-27T12:00:00Z',
            fetchedAt: '2026-09-27T12:00:00Z',
            amountBasis: 'provider_reported_cost',
            scope: 'Projects: proj_a; API keys: key_a',
            message: 'Selected source scope.',
            lines: [
              {
                service: 'OpenAI',
                detail: 'proj_a · key_a · Input tokens',
                currency: 'USD',
                cost: 0.00000012,
                credits: 0,
                net: 0.00000012,
                projectId: 'proj_a',
                apiKeyId: 'key_a',
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('Reported cost');
    expect(html).toContain('Project: proj_a');
    expect(html).toContain('API key ID: key_a');
    expect(html).toContain('Credits</th>');
    expect(html).toContain('Net spend</th>');
    expect(html).toContain('Not reported');
    expect(html).toContain('Latest export: time not reported');
    expect(html).toContain('Latest usage: time not reported');
    expect(html).not.toContain('Credits: $0.00');
  });

  it('shows whole-app incompleteness and source-scoped gaps without inventing an aggregate', () => {
    const coverage = billingCoverageProjection([
      {
        ...report,
        status: 'reported',
        message: 'Project-scoped export.',
        scope: 'Project: assistant',
      },
      {
        ...report,
        id: 'openrouter',
        label: 'OpenRouter',
        status: 'reported',
        message: 'Connected API key.',
        scope: 'Connection: OpenRouter',
      },
    ]);
    const html = renderToStaticMarkup(<BillingCoverageSummary coverage={coverage} />);
    expect(html).toContain('Whole-app total unavailable');
    expect(html).toContain('missing coverage is unknown rather than zero.');
    expect(html).toContain('Project: assistant');
    expect(html).toContain('Connection: OpenRouter');
    expect(html).toContain('Phone calls');
    expect(html).toContain(
      'Media, model, transcription and answer-detection components may be estimates or unknown',
    );
    expect(html).toContain('External accounts or unselected cloud scopes');
    expect(html).toContain('assistant spending limits do not cap provider or cloud bills');
    expect(html).not.toContain('$0.00');
  });

  it('shows missing spend as unavailable rather than zero', () => {
    const html = renderToStaticMarkup(<ProviderBillingCards reports={[report]} />);
    expect(html).toContain('Setup needed');
    expect(html).toContain('Open Google Cloud Billing');
    expect(html).toContain('Project: assistant');
    expect(html).toContain('Missing costs are unknown, not zero.');
    const setupDetails = html.indexOf('<details');
    expect(html.indexOf('Open Google Cloud Billing')).toBeLessThan(setupDetails);
    expect(html.indexOf('Export setup steps and guide')).toBeGreaterThan(setupDetails);
    expect(html.indexOf('Enable standard usage export')).toBeGreaterThan(setupDetails);
    expect(html.indexOf('Export setup guide')).toBeGreaterThan(setupDetails);
    expect(html.slice(setupDetails)).not.toMatch(/^<details[^>]*\sopen(?:\s|>)/);
    expect(html).not.toContain('$0.00');
  });

  it('shows actual stale and unavailable feeds above hypothetical coverage entries', () => {
    const coverage = billingCoverageProjection([
      { ...report, status: 'stale', message: 'Export delayed.' },
      {
        ...report,
        id: 'vertex',
        label: 'Google Vertex AI',
        status: 'unavailable',
        message: 'No matching project usage row.',
      },
    ]);
    const html = renderToStaticMarkup(<BillingCoverageSummary coverage={coverage} />);
    const detailsStart = html.indexOf('<details');
    const visibleSummary = html.slice(0, detailsStart);
    expect(visibleSummary).toContain(
      'Current feeds: Google Cloud stale; Google Vertex AI unavailable.',
    );
    expect(visibleSummary).toContain('Missing costs remain unknown, not zero.');
    expect(visibleSummary).not.toContain('Phone calls');
  });
  it('keeps currencies separate, displays credits and identifies stale data', () => {
    const html = renderToStaticMarkup(
      <ProviderBillingCards
        reports={[
          {
            ...report,
            status: 'stale',
            fetchedAt: '2026-09-26T00:00:00.000Z',
            lines: [
              {
                service: 'Cloud Firestore',
                detail: '',
                currency: 'USD',
                cost: 10,
                credits: -2,
                net: 8,
              },
              { service: 'Cloud Run', detail: '', currency: 'EUR', cost: 3, credits: 0, net: 3 },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('$8.00');
    expect(html).toContain('€3.00');
    expect(html).toContain('-$2.00');
    expect(html).toContain('Stale');
    expect(html).toContain('Fetched: Sep 26, 2026');
    expect(html).not.toContain('$11.00');
  });

  it('keeps source status and lag visible while placing run rates and line detail behind disclosure', () => {
    const html = renderToStaticMarkup(
      <ProviderBillingCards
        reports={[
          {
            ...report,
            status: 'stale',
            message: 'Delayed export; latest usage is not complete.',
            fetchedAt: '2026-09-26T00:00:00.000Z',
            latestExportAt: '2026-09-25T03:00:00Z',
            latestUsageAt: '2026-09-24T00:00:00Z',
            lines: [
              {
                service: 'Cloud Run',
                detail: 'regional compute',
                currency: 'USD',
                cost: 12,
                credits: -3,
                net: 9,
              },
            ],
            forecast: {
              through: '2026-09-24T00:00:00Z',
              observedDays: 23,
              daysInMonth: 30,
              totals: [{ currency: 'USD', spent: 9, dailyAverage: 0.39, projected: 11.7 }],
              message: 'Run rate assumes similar use; not an invoice forecast.',
            },
          },
        ]}
      />,
    );
    const detailsStart = html.indexOf('<details');
    expect(detailsStart).toBeGreaterThan(-1);
    expect(html.slice(detailsStart)).not.toMatch(/^<details[^>]*open/);
    for (const visibleBeforeDetails of [
      'Stale',
      '$9.00',
      'Project: assistant',
      '2026-09',
      'Cloud Billing export',
      'Delayed export; latest usage is not complete.',
      'Latest export',
    ]) {
      expect(html.indexOf(visibleBeforeDetails)).toBeGreaterThanOrEqual(0);
      expect(html.indexOf(visibleBeforeDetails)).toBeLessThan(detailsStart);
    }
    for (const detailFact of [
      'Estimated month end',
      'not an invoice forecast',
      'Cloud Run',
      'regional compute',
      'Cost',
      '$12.00',
      'Credits',
      'Net spend',
      '-$3.00',
    ]) {
      expect(html.indexOf(detailFact)).toBeGreaterThan(detailsStart);
    }
  });
});

it('shows forecast and inclusion without creating a second Vertex total', () => {
  const html = renderToStaticMarkup(
    <ProviderBillingCards
      reports={[
        {
          ...report,
          status: 'reported',
          lines: [
            { service: 'Vertex AI', detail: '', currency: 'USD', cost: 15, credits: 0, net: 15 },
          ],
          forecast: {
            through: '2026-09-16T00:00:00Z',
            observedDays: 15,
            daysInMonth: 30,
            totals: [{ currency: 'USD', spent: 15, dailyAverage: 1, projected: 30 }],
            message: 'Assumes similar usage.',
          },
        },
        {
          ...report,
          id: 'vertex',
          label: 'Google Vertex AI',
          status: 'included',
          includedIn: 'google-cloud',
        },
      ]}
    />,
  );
  expect(html).toContain('Estimated month end');
  expect(html).toContain('$30.00');
  expect(html).toContain('Average per day');
  expect(html).toContain('Vertex is included only');
  expect(html).toContain('In Google Cloud report');
  expect(html).not.toContain('Unavailable');
});

it('preserves nonzero sub-cent totals and credits instead of displaying zero', () => {
  const html = renderToStaticMarkup(
    <ProviderBillingCards
      reports={[
        {
          ...report,
          id: 'openrouter',
          label: 'OpenRouter',
          status: 'stale',
          message: 'Stale key snapshot.',
          lines: [
            {
              service: 'Key usage',
              detail: 'reported usage',
              currency: 'USD',
              cost: 0.0006,
              credits: -0.0002,
              net: 0.0004,
            },
          ],
        },
      ]}
    />,
  );

  expect(html).toContain('$0.0004');
  expect(html).toContain('$0.0006');
  expect(html).toContain('-$0.0002');
  expect(html).not.toMatch(/>\$0\.00</);
});

describe('ledger evidence within the single coverage entry', () => {
  function renderLedger(
    rows?: Parameters<typeof billingCoverageProjection>[1],
    reports: ProviderBilling[] = [],
  ) {
    const coverage = billingCoverageProjection(reports, rows);
    const html = renderToStaticMarkup(
      <>
        <BillingCoverageSummary coverage={coverage} />
        <ProviderBillingCards reports={reports} />
      </>,
    );
    expect(html).toContain('Whole-app total unavailable');
    return html;
  }

  it('names the usage breakdown on the collapsed native disclosure with a visible chevron', () => {
    const html = renderLedger([{ basis: 'provider_reported', usd: '0.12', count: 1 }]);
    expect(html).toContain('Cost sources and usage breakdown (5)');
    expect(html).toMatch(
      /<details[^>]*><summary[^>]*>.*?lucide-chevron-right.*?<span>Cost sources and usage breakdown/s,
    );
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|>)/);
    expect(html.match(/Assistant ledger evidence/g)).toHaveLength(1);
  });

  it('distinguishes absent and empty evidence from a recorded explicit zero', () => {
    for (const rows of [undefined, null, []]) {
      const html = renderLedger(rows);
      expect(html).toContain('Empty evidence does not establish zero spending or no activity.');
      expect(html).not.toContain('Ledger USD 0');
      expect(html).not.toContain('$0.00');
    }
    const zero = renderLedger([{ basis: 'provider_reported', usd: '0.000000', count: 1 }]);
    expect(zero).toContain('Ledger USD 0.000000');
    expect(zero).toContain('1 recorded event');
    expect(zero).toContain('Provider-reported operation receipts');
    expect(zero).toContain('coverage remains unverified');
  });

  it('renders every basis and duplicate group separately, preserving tiny amounts and counts without a subtotal', () => {
    const html = renderLedger([
      { basis: 'provider_reported', usd: '1.250000', count: 2 },
      { basis: 'token_rate', usd: '0.000003', count: 3 },
      { basis: 'preflight_estimate', usd: '2.5000', count: 4 },
      { basis: 'component_ledger', usd: '3.125', count: 5 },
      { basis: 'unknown', usd: '4.000000', count: 6 },
      { basis: 'unknown', usd: '0.100', count: 7 },
    ]);
    for (const basis of [
      'provider_reported',
      'token_rate',
      'preflight_estimate',
      'component_ledger',
      'unknown',
    ]) {
      expect(html).toContain(`data-cost-basis="${basis}"`);
    }
    for (const amount of ['1.250000', '0.000003', '2.5000', '3.125', '4.000000', '0.100']) {
      expect(html).toContain(`Ledger USD ${amount}`);
    }
    expect(html).toContain('Separate rows; no subtotal.');
    expect(html).toContain('Mixed reported and estimated components');
    expect(html).toContain('Unverified ledger records');
    expect(html).toContain('7 recorded events');
    expect(html).toContain('Held reservations and unknown liability are separate');
    expect(html.match(/aria-label="Assistant ledger evidence"/g)).toHaveLength(1);
  });

  it('keeps malformed values unknown and safe unknown-basis values visible as unverified', () => {
    const malformed = [
      { basis: 'token_rate', usd: 'Infinity', count: Number.NaN },
      { basis: 'provider_reported', usd: undefined, count: -1 },
      { basis: 'unexpected_basis', usd: '0.000008', count: 2 },
    ] as unknown as NonNullable<Parameters<typeof billingCoverageProjection>[1]>;
    const html = renderLedger(malformed);
    expect(html).toContain('Amount unknown');
    expect(html).toContain('Event count unknown');
    expect(html).toContain('Unverified ledger records');
    expect(html).toContain('Ledger USD 0.000008');
    expect(html).not.toContain('Infinity');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('$0.00');
  });

  it('keeps paired provider amounts, currencies, shared-key scope and coverage gaps distinct from ledger receipts', () => {
    const reports: ProviderBilling[] = [
      {
        ...report,
        id: 'openrouter',
        label: 'OpenRouter',
        status: 'reported',
        period: '2026-10',
        scope: 'Shared key: all users',
        message: 'Includes unrelated usage; not assistant-only.',
        lines: [
          {
            service: 'OpenRouter',
            detail: 'Saved-key usage',
            currency: 'USD',
            cost: 2.5,
            credits: 0,
            net: 2.5,
          },
        ],
      },
      {
        ...report,
        id: 'cloud-eur',
        status: 'stale',
        period: '2026-09',
        scope: 'Project: separate',
        message: 'Export delayed.',
        lines: [
          {
            service: 'Cloud Run',
            detail: 'Scoped export',
            currency: 'EUR',
            cost: 8,
            credits: 0,
            net: 8,
          },
        ],
      },
      {
        ...report,
        id: 'vertex',
        label: 'Google Vertex AI',
        status: 'unavailable',
        message: 'No matching project usage row.',
        lines: [],
      },
    ];
    const html = renderLedger([{ basis: 'provider_reported', usd: '2.500000', count: 1 }], reports);
    expect(html).toContain('$2.50');
    expect(html).toContain('Ledger USD 2.500000');
    expect(html).toContain('€8.00');
    expect(html).toContain('Shared key: all users');
    expect(html).toContain('Includes unrelated usage; not assistant-only.');
    expect(html).toContain('2026-10');
    expect(html).toContain('2026-09');
    expect(html).toContain('No matching project usage row.');
    expect(html).toContain('Assistant usage-ledger amounts may overlap provider bills.');
    expect(html).toContain(
      'Exact period boundaries, source/account scope and freshness are not supplied',
    );
    expect(html).not.toContain('$5.00');
  });
});
