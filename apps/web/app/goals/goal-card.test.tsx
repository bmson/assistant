import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  archiveGoal: vi.fn(),
  restoreGoal: vi.fn(),
  setGoalAutonomy: vi.fn(),
  setGoalStatus: vi.fn(),
  startGoalWork: vi.fn(),
  updateGoal: vi.fn(),
}));

vi.mock('@/app/goals/actions', () => actions);

import { GoalCard, type GoalView, type ResearchAssignmentSummary } from './goal-card';

const baseGoal = (overrides: Partial<GoalView> = {}): GoalView => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Research a birthday gift',
  description: 'Find a useful gardening gift.',
  status: 'active',
  priority: 3,
  progress: '',
  nextAction: '',
  targetDateInput: '',
  updatedLabel: 'just now',
  archived: false,
  workActive: false,
  paceMeta: 'Checks in daily',
  automationNextLabel: 'next tomorrow',
  targetMeta: null,
  timelinePct: null,
  lastSessionLabel: '',
  blockedLabel: '',
  mirrorToPrimary: true,
  autonomy: true,
  taintedOrigin: false,
  ...overrides,
});

const assignment = (
  overrides: Partial<ResearchAssignmentSummary> = {},
): ResearchAssignmentSummary => ({
  kind: 'research_assignment',
  assignmentId: '22222222-2222-4222-8222-222222222222',
  outcome: 'Research three gardening gifts for Synthetic recipient.',
  brief: {
    completionCondition: 'Three current options within the total budget.',
    interests: ['Gardening'],
    exclusions: ['Cut flowers'],
    allowedSources: ['Manufacturer product pages'],
  },
  briefRevision: 2,
  resultBriefRevision: 2,
  status: 'waiting_for_decision',
  stateReason: null,
  currentness: 'checked_at',
  lastConfirmedAt: '2026-11-06T16:00:00.000Z',
  recipient: {
    name: 'Synthetic recipient',
    contactHref: '/people/33333333-3333-4333-8333-333333333333',
  },
  budget: { state: 'known', amount: '100', currency: 'USD', includesTaxAndDelivery: true },
  deadline: {
    state: 'known',
    at: '2026-12-05T17:00:00.000Z',
    timeZone: 'America/Los_Angeles',
  },
  scope: {
    label: 'Research only · no contact or purchase',
    contactAllowed: false,
    purchaseAllowed: false,
  },
  progress: 'Three options checked.',
  briefContext: [
    {
      value: 'Enjoys gardening',
      sourceLabel: 'People profile note',
      sourceDate: '2026-10-30',
      acceptedAt: '2026-11-06T16:00:00.000Z',
    },
  ],
  work: {
    taskId: '44444444-4444-4444-8444-444444444444',
    taskStatus: 'done',
    conversationId: '55555555-5555-4555-8555-555555555555',
  },
  evidence: {
    resultRevision: 2,
    checkedAt: '2026-11-06T16:00:00.000Z',
    optionCount: 3,
    unverifiedCount: 1,
    recommendationId: 'option-1',
    options: [
      {
        id: 'option-1',
        title: 'Garden gloves',
        description: 'Durable gloves for garden work.',
        sourceName: 'Synthetic Garden Shop',
        sourceUrl: 'https://example.invalid/gloves',
        checkedAt: '2026-11-06T16:00:00.000Z',
        itemCost: '80.00',
        taxCost: '8.00',
        deliveryCost: '12.00',
        currency: 'USD',
        totalCost: '100.00',
        budgetAssessment: 'within_limit',
        availability: 'verified_available',
        deliveryConfidence: 'verified',
      },
    ],
  },
  completion: null,
  primaryHref:
    '/chat/55555555-5555-4555-8555-555555555555?task=44444444-4444-4444-8444-444444444444',
  currentWorkHref: null,
  ...overrides,
});

// Optional synthetic source-component exports use the existing SSR fixture seam.
const visualDirectory = process.env.RESEARCH_ASSIGNMENT_VISUAL_DIR;
if (visualDirectory) {
  mkdirSync(visualDirectory, { recursive: true });
  const scenarios = {
    waiting: assignment(),
    uncertain: assignment({
      status: 'unknown',
      currentness: 'unknown',
      progress: 'Current work could not be confirmed. Last recorded options are kept.',
      stateReason: 'Check saved work before starting anything new.',
    }),
    reopened: assignment({ status: 'needs_recheck', currentness: 'stale', resultBriefRevision: 1 }),
    completed: assignment({
      status: 'completed',
      completion: {
        kind: 'shortlist_accepted',
        resultRevision: 2,
        acceptedAt: '2026-11-06T16:00:00.000Z',
      },
    }),
  };
  for (const [name, summary] of Object.entries(scenarios)) {
    const html = renderToStaticMarkup(
      <GoalCard goal={baseGoal({ researchAssignment: summary })} />,
    );
    writeFileSync(
      path.join(visualDirectory, `${name}.html`),
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><title>Synthetic research assignment</title></head><body class="bg-surface font-sans text-strong"><main class="p-4"><p class="mb-3 text-xs text-muted">Synthetic source fixture · no live assignment</p>${html}</main></body></html>`,
    );
  }
}

it('renders the research assignment status, constraints, freshness, and accepted profile provenance', () => {
  const html = renderToStaticMarkup(
    <GoalCard goal={baseGoal({ researchAssignment: assignment() })} />,
  );

  expect(html).toContain('Research only · no contact or purchase');
  expect(html).toContain('Accepted brief constraints');
  expect(html).toContain('Three current options within the total budget.');
  expect(html).toContain('Gardening');
  expect(html).toContain('Cut flowers');
  expect(html).toContain('Manufacturer product pages');
  expect(html).toContain('Synthetic recipient');
  expect(html).toContain('100 USD · includes tax and delivery');
  expect(html).toContain('Due Dec 5, 2026');
  expect(html).toContain('Waiting for your decision');
  expect(html).toContain('Sources checked 2026-11-06 16:00:00 UTC');
  expect(html).toContain('Accepted profile context (1)');
  expect(html).toContain('People profile note');
  expect(html).toContain('Garden gloves');
  expect(html).toContain('100.00 USD');
  expect(html).toContain('Listed available at check time');
  expect(html).toContain('2026-10-30');
  expect(html).toContain('Review options');
  expect(html).not.toContain('Checks in daily');
  expect(html).not.toContain('next tomorrow');
  expect(html).not.toContain('Autonomous');
  expect(html).not.toContain('Pause automation');
  expect(html).not.toContain('Start work now');
  expect(html).not.toContain('<form');
});

it('keeps unknown constraints and stale results explicit', () => {
  const html = renderToStaticMarkup(
    <GoalCard
      goal={baseGoal({
        researchAssignment: assignment({
          budget: { state: 'unknown', amount: null, currency: null, includesTaxAndDelivery: null },
          deadline: { state: 'unknown', at: null, timeZone: null },
          currentness: 'stale',
          resultBriefRevision: 1,
        }),
      })}
    />,
  );

  expect(html).toContain('Budget unknown');
  expect(html).toContain('Deadline unknown');
  expect(html).toContain('Results may be out of date');
  expect(html).toContain('The brief changed after these results');
});

it('does not turn a completed task into assignment completion', () => {
  const html = renderToStaticMarkup(
    <GoalCard
      goal={baseGoal({
        researchAssignment: assignment({
          status: 'researching',
          work: {
            taskId: '44444444-4444-4444-8444-444444444444',
            taskStatus: 'done',
            conversationId: null,
          },
          primaryHref: null,
        }),
      })}
    />,
  );

  expect(html).toContain('Researching');
  expect(html).not.toContain('Shortlist accepted');
  expect(html).not.toContain('Completed');
});

it('only renders a validated internal assignment link', () => {
  const html = renderToStaticMarkup(
    <GoalCard
      goal={baseGoal({
        researchAssignment: assignment({ primaryHref: 'https://evil.example/steal' }),
      })}
    />,
  );

  expect(html).toContain('Assignment record link unavailable');
  expect(html).not.toContain('https://evil.example');
});

it('offers the dashboard-linked chat when assignment work links do not match', () => {
  const html = renderToStaticMarkup(
    <GoalCard
      goal={baseGoal({
        conversationId: '66666666-6666-4666-8666-666666666666',
        researchAssignment: assignment({
          primaryHref: null,
          currentWorkHref: '/chat/66666666-6666-4666-8666-666666666666',
        }),
      })}
    />,
  );

  expect(html).toContain('Check current work');
  expect(html).toContain('href="/chat/66666666-6666-4666-8666-666666666666"');
  expect(html).not.toContain('task=');
  expect(html).not.toContain('href="/chat/55555555-5555-4555-8555-555555555555');
});

it('keeps the ordinary GoalCard path when no assignment summary is provided', () => {
  const html = renderToStaticMarkup(<GoalCard goal={baseGoal()} />);

  expect(html).toContain('Find a useful gardening gift.');
  expect(html).toContain('Checks in daily');
  expect(html).toContain('Pause automation');
  expect(html).toContain('Autonomous');
  expect(html).not.toContain('Research only · no contact or purchase');
});

it.each([
  'https://evil.example/steal',
  '/chat/66666666-6666-4666-8666-666666666666?task=44444444-4444-4444-8444-444444444444',
  '/chat/55555555-5555-4555-8555-555555555555?task=66666666-6666-4666-8666-666666666666',
  '/chat/55555555-5555-4555-8555-555555555555?task=44444444-4444-4444-8444-444444444444&task=44444444-4444-4444-8444-444444444444',
  '/chat/------------------------------------?task=44444444-4444-4444-8444-444444444444',
])('rejects a primary link outside the recorded work identity: %s', (primaryHref) => {
  const html = renderToStaticMarkup(
    <GoalCard goal={baseGoal({ researchAssignment: assignment({ primaryHref }) })} />,
  );
  expect(html).toContain('Assignment record link unavailable');
  expect(html).not.toContain('>Review options</a>');
});

it('keeps the shortlist collapsed behind one keyboard-native detail disclosure', () => {
  const html = renderToStaticMarkup(
    <GoalCard goal={baseGoal({ researchAssignment: assignment() })} />,
  );
  expect(html).toContain('Brief and sources</summary>');
  expect(html).not.toContain('<details open');
  expect(html.indexOf('Brief and sources')).toBeLessThan(html.indexOf('Garden gloves'));
  expect(html).toContain('focus-visible:outline');
  expect(html.match(/>Review options<\/a>/g)).toHaveLength(1);
  expect(html).not.toContain('<form');
});

it('does not present historical completion as current after the brief changes', () => {
  const html = renderToStaticMarkup(
    <GoalCard
      goal={baseGoal({
        researchAssignment: assignment({
          status: 'completed',
          resultBriefRevision: 1,
          completion: {
            kind: 'shortlist_accepted',
            resultRevision: 2,
            acceptedAt: '2026-11-06T16:00:00.000Z',
          },
        }),
      })}
    />,
  );
  expect(html).toContain('Needs a fresh check');
  expect(html).toContain('Check current work');
  expect(html).not.toContain('Shortlist accepted');
});

it.each([
  'draft',
  'researching',
  'waiting_for_decision',
  'blocked',
  'paused',
  'completed',
  'cancelled',
  'needs_recheck',
  'unknown',
] as const)('reopens %s with no implicit work or automation controls', (status) => {
  const html = renderToStaticMarkup(
    <GoalCard goal={baseGoal({ researchAssignment: assignment({ status }) })} />,
  );
  expect(html).not.toContain('<form');
  expect(html).not.toContain('Pause automation');
  expect(html).not.toContain('Start work now');
  expect(html).not.toContain('Checks in daily');
  expect(Object.values(actions).every((action) => action.mock.calls.length === 0)).toBe(true);
});

it('keeps a malformed assignment unavailable without falling back to goal controls', () => {
  const malformed = { ...assignment(), recipient: null } as unknown as ResearchAssignmentSummary;
  const html = renderToStaticMarkup(
    <GoalCard goal={baseGoal({ researchAssignment: malformed })} />,
  );
  expect(html).toContain('Assignment details unavailable');
  expect(html).not.toContain('Shortlist accepted');
  expect(html).not.toContain('<form');
  expect(html).not.toContain('Checks in daily');
});

it('withholds claims when the research-only display scope cannot be verified', () => {
  const invalid = {
    ...assignment(),
    scope: {
      label: 'Research only · no contact or purchase',
      contactAllowed: true,
      purchaseAllowed: false,
    },
  } as unknown as ResearchAssignmentSummary;
  const html = renderToStaticMarkup(<GoalCard goal={baseGoal({ researchAssignment: invalid })} />);
  expect(html).toContain('Assignment details unavailable');
  expect(html).not.toContain('Review options');
  expect(html).not.toContain('Shortlist accepted');
  expect(html).not.toContain('<form');
});

it('keeps missing or malformed brief structure unavailable instead of showing goal actions', () => {
  for (const brief of [
    undefined,
    {},
    { ...assignment().brief, interests: null },
    { ...assignment().brief, interests: [{}] },
  ]) {
    const invalid = { ...assignment(), brief } as unknown as ResearchAssignmentSummary;
    const html = renderToStaticMarkup(
      <GoalCard goal={baseGoal({ researchAssignment: invalid })} />,
    );
    expect(html).toContain('Assignment details unavailable');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Shortlist accepted');
  }
});

it('rejects fallback chats that differ from the dashboard-linked conversation', () => {
  for (const currentWorkHref of [
    '/chat/66666666-6666-4666-8666-666666666666',
    '/chat/55555555-5555-4555-8555-555555555555?task=44444444-4444-4444-8444-444444444444',
    '/chat/55555555-5555-4555-8555-555555555555\n',
    '/chat/55555555-5555-4555-8555-555555555555#other',
    'https://evil.example/chat/55555555-5555-4555-8555-555555555555',
    '/chat/55555555-5555-4555-8555-555555555555\\other',
  ]) {
    const html = renderToStaticMarkup(
      <GoalCard
        goal={baseGoal({
          conversationId: '55555555-5555-4555-8555-555555555555',
          researchAssignment: assignment({ primaryHref: null, currentWorkHref }),
        })}
      />,
    );
    expect(html).toContain('Assignment record link unavailable');
    expect(html).not.toContain('>Check current work</a>');
  }
});
