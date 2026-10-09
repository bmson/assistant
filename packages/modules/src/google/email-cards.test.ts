import type { ModelRouter } from '@assistant/core/model-router';
import type {
  GeneratedCardPersistInput,
  GeneratedCardRepository,
  NotificationsConversationRepository,
} from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  applyPreparedEmailCard,
  cardFromEmail,
  mayBeCardWorthy,
  prepareEmailCard,
  withoutSenderLinks,
} from './email-cards.js';

const hotel = {
  subject: 'Your reservation at Hotel Kabuki is confirmed',
  body: [
    'Thank you for booking with us, Baldvin.',
    'Confirmation number: 73535835545212',
    'Check-in: Friday, October 9, 2026 from 3:00 PM',
    'Check-out: Sunday, October 11, 2026 by 11:00 AM',
    'Room: King, garden view',
    'Total: $612.40',
    'Manage your booking: https://hotel-kabuki.example/manage/73535835545212',
    'To unsubscribe from service emails, update your preferences.',
  ].join('\n'),
};

describe('which mail is worth a card', () => {
  it('takes a booking with its details', () => {
    expect(mayBeCardWorthy(hotel.subject, hotel.body)).toBe(true);
    expect(
      mayBeCardWorthy(
        'Your tickets for Björk',
        "You're going! Section B, Row 12, Seats 4-5. Date: Sat, Nov 14 · Doors 7:00 PM. Harpa, Reykjavik. Order #88213. Total: 24,900 ISK.",
      ),
    ).toBe(true);
  });

  it('leaves sales, chatter and bare notices alone', () => {
    expect(
      mayBeCardWorthy(
        'Flash sale: 40% off hotels',
        'Book by Friday, October 9 — save 40% off at 300 hotels. Prices from $89. Shop now, sale ends Sunday at 11:59 PM.',
      ),
    ).toBe(false);
    expect(
      mayBeCardWorthy('Lunch?', 'Are you free Friday at 12:30? The usual place is booked though.'),
    ).toBe(false);
    expect(mayBeCardWorthy('Your order has shipped', 'Your order has shipped.')).toBe(false);
  });
});

describe('mail that only half looks like a booking', () => {
  it('needs the booking in the subject, or printed as fields', () => {
    expect(
      mayBeCardWorthy(
        'Re: dinner',
        'Confirmed! We are booked for Friday at 7:30 PM, table for 4. See you there.',
      ),
    ).toBe(false);
    expect(
      mayBeCardWorthy(
        'Fwd: Friday',
        'Reservation details\nRestaurant: Dill\nDate: Friday, October 9\nTime: 7:30 PM\nParty size: 4',
      ),
    ).toBe(true);
  });
});

describe('withoutSenderLinks', () => {
  it('drops links and images a sender put in, and keeps the rest', () => {
    const spec = {
      version: 1 as const,
      title: 'Hotel Kabuki',
      icon: 'hotel' as const,
      accent: 'mint' as const,
      accessibilityLabel: 'Hotel Kabuki',
      sourceLabel: 'Email',
      facts: [
        { id: 'room', label: 'Room', value: 'King, garden view', source: 'x', sensitive: false },
        {
          id: 'url',
          label: 'Manage',
          value: 'https://hotel-kabuki.example/manage',
          source: 'x',
          sensitive: false,
        },
      ],
      blocks: [
        { type: 'facts' as const, factIds: ['room'] },
        { type: 'image' as const, urlFact: 'url' },
        {
          type: 'section' as const,
          title: 'Links',
          blocks: [{ type: 'image' as const, urlFact: 'url' }],
        },
      ],
      actions: [
        { id: 'open', type: 'open_url' as const, label: 'Manage', factId: 'url' },
        { id: 'copy', type: 'copy_value' as const, label: 'Copy', factId: 'room' },
      ],
      refreshable: false,
    };
    const safe = withoutSenderLinks(spec);
    expect(safe?.blocks).toEqual([{ type: 'facts', factIds: ['room'] }]);
    expect(safe?.actions.map((action) => action.type)).toEqual(['copy_value']);
  });
});

describe('cardFromEmail', () => {
  function setup() {
    const saved: GeneratedCardPersistInput[] = [];
    const notices: string[] = [];
    const byFingerprint = new Map<string, string>();
    const generatedCards = {
      kind: 'generated-card-repository',
      async get() {
        return null;
      },
      async createOrRevise(input: GeneratedCardPersistInput) {
        saved.push(input);
        const id = byFingerprint.get(input.sourceFingerprint) ?? input.id;
        byFingerprint.set(input.sourceFingerprint, id);
        return {
          card: { id, sourceFingerprint: input.sourceFingerprint, updatedAt: new Date() },
          revision: { id: input.revisionId },
        };
      },
    } as unknown as GeneratedCardRepository;
    let composerCalls = 0;
    const router = {
      async object() {
        composerCalls += 1;
        return {
          ok: true,
          object: {
            cardable: true,
            card: {
              version: 1,
              title: 'Hotel Kabuki',
              icon: 'hotel',
              accessibilityLabel: 'Hotel Kabuki reservation, October 9 to 11',
              sourceLabel: 'Hotel email',
              facts: [
                {
                  id: 'ref',
                  label: 'Confirmation number',
                  value: '73535835545212',
                  source: 'TOOL_1',
                  sensitive: true,
                },
                {
                  id: 'in',
                  label: 'Check-in',
                  value: 'Friday, October 9, 2026 from 3:00 PM',
                  source: 'TOOL_1',
                },
                {
                  id: 'out',
                  label: 'Check-out',
                  value: 'Sunday, October 11, 2026 by 11:00 AM',
                  source: 'TOOL_1',
                },
                {
                  id: 'url',
                  label: 'Manage',
                  value: 'https://hotel-kabuki.example/manage/73535835545212',
                  source: 'TOOL_1',
                },
              ],
              blocks: [
                { type: 'timeline', factIds: ['in', 'out'] },
                { type: 'code', valueFact: 'ref', format: 'text' },
              ],
              actions: [{ id: 'manage', type: 'open_url', label: 'Manage booking', factId: 'url' }],
            },
          },
        };
      },
    } as unknown as ModelRouter;
    const notifications = {
      kind: 'notifications-conversation-repository',
      getOrCreate: async () => 'notifications-chat',
    } as NotificationsConversationRepository;
    const deps = {
      router,
      generatedCards,
      notifications,
      notifyOwner: async ({ text }: { text: string }) => {
        notices.push(text);
      },
    };
    return { deps, saved, notices, calls: () => composerCalls };
  }

  const event = {
    agentId: 'a1',
    messageId: 'm1',
    from: 'reservations@hotel-kabuki.example',
    authenticated: true,
    ...hotel,
  };

  it('saves a grounded card without the sender link, and says so once', async () => {
    const { deps, saved, notices } = setup();
    const card = await cardFromEmail(deps, event);
    expect(card?.spec.title).toBe('Hotel Kabuki');
    expect(card?.spec.actions).toEqual([]);
    expect(saved[0]?.conversationId).toBe('notifications-chat');
    expect(notices).toEqual(['Saved “Hotel Kabuki” from your email to your Cards page.']);

    // The hotel's reminder carries the same confirmation number: the card is
    // revised in place, and the owner is not told again.
    await cardFromEmail(deps, { ...event, messageId: 'm2' });
    expect(saved).toHaveLength(2);
    expect(saved[1]?.sourceFingerprint).toBe(saved[0]?.sourceFingerprint);
    expect(notices).toHaveLength(1);
  });

  it('never asks a model about mail that fails the prefilter', async () => {
    const { deps, calls } = setup();
    await cardFromEmail(deps, {
      ...event,
      subject: 'Flash sale: 40% off',
      body: 'Shop now, sale ends Friday at 5 PM. Save $40.',
    });
    expect(calls()).toBe(0);
  });

  it('treats a flight booking as one more booking', async () => {
    const { deps, calls } = setup();
    await cardFromEmail(deps, {
      ...event,
      subject: 'Your flight confirmation',
      body: 'Flight FI 614 departs Friday, October 9 at 16:40. Booking reference XJ4K2P. Total: $612.40',
    });
    expect(calls()).toBe(1);
  });

  it('refuses a card whose values the email never stated', async () => {
    const { deps, saved } = setup();
    const card = await cardFromEmail(deps, {
      ...event,
      body: hotel.body.replace('Friday, October 9, 2026 from 3:00 PM', 'Friday, October 9 at 3 PM'),
    });
    expect(card).toBeNull();
    expect(saved).toEqual([]);
  });

  it('keeps a structured-composition failure unknown for the durable worker', async () => {
    const result = await prepareEmailCard(
      {
        router: {
          async object() {
            return { ok: false, errorCode: 'provider_timeout' };
          },
        } as unknown as ModelRouter,
      },
      {
        ...event,
        sourceId: 'gmail:m1',
        messageId: 'm1',
      } as never,
    );

    expect(result).toEqual({ kind: 'unknown', errorCode: 'email_card_effect_unknown' });
  });
});

describe('durable email card effect fence', () => {
  it('passes the exact observer claim and privacy generation into the card write', async () => {
    const saved: GeneratedCardPersistInput[] = [];
    const conversationFences: unknown[] = [];
    const noticeFences: unknown[] = [];
    const deps = {
      router: {} as ModelRouter,
      generatedCards: {
        async get() {
          return null;
        },
        async createOrRevise(input: GeneratedCardPersistInput) {
          saved.push(input);
          return {
            card: {
              id: input.id,
              sourceFingerprint: input.sourceFingerprint,
              updatedAt: new Date(),
            },
            revision: { id: input.revisionId },
          };
        },
      } as unknown as GeneratedCardRepository,
      notifications: {
        kind: 'notifications-conversation-repository',
        getOrCreate: async (_agentId: string, fence?: unknown) => {
          conversationFences.push(fence);
          return 'notifications-chat';
        },
      } as NotificationsConversationRepository,
      notifyOwner: async (input: { emailObserverEffectFence?: unknown }) => {
        noticeFences.push(input.emailObserverEffectFence);
        return { legs: [{ channel: 'dashboard', status: 'pending' as const }] };
      },
    };
    const source = {
      agentId: 'owner-1',
      messageId: 'message-1',
      sourceId: 'gmail:provider-1',
      from: 'reservations@example.test',
      subject: hotel.subject,
      body: hotel.body,
      authenticated: true,
      origin: 'owner',
      contentTrust: 'owner',
      ingestMode: 'direct',
      sourceVerification: 'authenticated',
      hasExternalOrUnknown: false,
    } as const;
    const claim = {
      id: 'observer-work-1',
      agentId: 'owner-1',
      observerKey: 'google.email-card',
      observerVersion: 1,
      claimToken: 'lease-token',
      claimGeneration: 3,
      privacyGeneration: 'privacy-7',
    } as import('@assistant/persistence').EmailObserverClaim;
    const prepared = {
      kind: 'generated-card',
      id: '2c301781-3be3-41bc-b577-4e5fe9cd69d0',
      revisionId: '6a35f8a2-bb66-40ec-94cc-59122814f0cd',
      sourceFingerprint: 'a'.repeat(64),
      grounding: 'evidence',
      spec: {
        version: 1,
        title: 'Hotel Kabuki',
        icon: 'hotel',
        accent: 'mint',
        accessibilityLabel: 'Hotel Kabuki reservation',
        sourceLabel: 'Email',
        facts: [
          { id: 'date', label: 'Check-in', value: 'October 9', source: 'Email', sensitive: false },
        ],
        blocks: [{ type: 'facts', factIds: ['date'] }],
        actions: [],
        refreshable: false,
      },
    };

    await applyPreparedEmailCard(deps, source, claim, prepared);

    expect(saved).toHaveLength(1);
    const expectedFence = {
      id: claim.id,
      agentId: claim.agentId,
      claimToken: claim.claimToken,
      claimGeneration: claim.claimGeneration,
      expectedPrivacyGeneration: claim.privacyGeneration,
    };
    expect(saved[0]?.emailObserverEffectFence).toEqual(expectedFence);
    expect(conversationFences).toEqual([expectedFence]);
    expect(noticeFences).toEqual([expectedFence]);
  });
});
