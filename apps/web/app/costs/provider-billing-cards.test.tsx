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
    expect(html).toContain('Fetched 2026-09-26');
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
