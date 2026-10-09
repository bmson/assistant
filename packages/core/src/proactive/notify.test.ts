import type { Db } from '@assistant/db';
import { type GraphCuriosityRepository, notificationLeg } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { runCuriosity } from './curiosity.js';
import { pingOwner } from './notify.js';

const input = { conversationId: 'visible-notice', text: 'Question' };
describe('proactive notification receipts', () => {
  it('reports a typed accepted provider leg as delivered', async () => {
    expect(await pingOwner(async () => notificationLeg('push', 'delivered'), input)).toBe(true);
  });
  it.each(['held', 'skipped', 'failed', 'unknown'] as const)(
    'preserves %s as no acknowledged phone delivery',
    async (status) => {
      expect(
        await pingOwner(async () => notificationLeg('push', status, 'safe-detail'), input),
      ).toBe(false);
    },
  );
  it('does not call a dashboard copy a phone ping', async () => {
    expect(await pingOwner(async () => notificationLeg('dashboard', 'delivered'), input)).toBe(
      false,
    );
  });
  it('does not promote legacy void completion into delivery or imply a phone exists', async () => {
    expect(await pingOwner(async () => {}, input)).toBe(false);
    expect(await pingOwner(undefined, input)).toBe(false);
  });
});

describe('curiosity notification receipt', () => {
  it('keeps the visible question and reports only its atomic push leg as pending', async () => {
    const asked = new Set<string>();
    const graph: GraphCuriosityRepository = {
      kind: 'graph-curiosity-repository',
      observationFence: async () => null,
      gapInputs: async () => ({
        connected: [
          { id: 'alex', label: 'Alex', kind: 'person', contactId: 'alex-contact', degree: 2 },
        ],
        held: [],
      }),
      askedKeys: async (_owner, keys) => keys.filter((key) => asked.has(key)),
      admitQuestion: async ({ key }) => {
        asked.add(key);
        return {
          status: 'posted',
          conversationId: 'visible-question',
          messageId: 'notice',
          pushAdmission: { status: 'queued', destinations: 1 },
        };
      },
    };
    const phone = notificationLeg('push', 'held', 'quiet-hours');
    let notifierCalls = 0;
    const deps = {
      db: {} as Db,
      persistence: { graphCuriosity: graph },
      notifyOwner: async () => {
        notifierCalls += 1;
        return phone;
      },
    };
    const result = await runCuriosity(deps, { agentId: 'owner' });
    expect(result).toMatchObject({
      status: 'posted',
      pinged: false,
      notification: { legs: [{ channel: 'push', status: 'pending' }] },
    });
    expect(notifierCalls).toBe(0);
    expect(result.asked).not.toBeNull();
    expect((await runCuriosity(deps, { agentId: 'owner' })).asked).toBe('missing-predicate');
    expect((await runCuriosity(deps, { agentId: 'owner' })).status).toBe('skipped');
  });
});
