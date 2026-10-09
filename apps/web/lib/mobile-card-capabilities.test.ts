import { describe, expect, it } from 'vitest';
import { projectMobileCardCapabilities } from './mobile-card-capabilities';

const card = (version = 1) => ({
  kind: 'generated-card',
  id: 'stable-card-id',
  revisionId: 'stable-revision-id',
  spec: {
    version,
    title: 'Travel plan',
    sourceLabel: 'Booking email',
    accessibilityLabel: 'Travel plan',
    facts: [
      { id: 'flight', label: 'Flight', value: 'FI 614 on Friday', source: 'email' },
      { id: 'secret', label: 'Ticket code', value: 'ABCD-1234', source: 'email', sensitive: true },
    ],
    blocks: [{ type: 'facts', factIds: ['flight'] }],
    actions: [],
  },
});

const request = (schema?: string, forms?: string) =>
  new Request('https://assistant.test/api/mobile/v1/chats/id', {
    headers: {
      ...(schema === undefined ? {} : { 'x-assistant-card-schema': schema }),
      ...(forms === undefined ? {} : { 'x-assistant-card-forms': forms }),
    },
  });

const formCard = () => ({
  ...card(),
  spec: {
    ...card().spec,
    blocks: [
      {
        type: 'form',
        id: 'trip_plan',
        title: 'Plan this trip',
        serverAction: 'submit_owner_chat_turn',
        submitLabel: 'Review in message',
        warningFactIds: [],
        fields: [{ id: 'destination', type: 'text', label: 'Destination', required: true }],
      },
    ],
  },
});

describe('mobile native card capability projection', () => {
  it('preserves complete prose for schema-zero clients and keeps stable message identities', () => {
    const page = {
      messages: [
        {
          id: 'message-1',
          text: 'Your flight is FI 614 on Friday.',
          parts: [{ type: 'data-card', data: card() }],
        },
        {
          id: 'message-2',
          text: 'Plain answer.',
          parts: [{ type: 'text', text: 'Plain answer.' }],
        },
      ],
    };
    const projected = projectMobileCardCapabilities(page, request());
    expect(projected.messages[0]).toEqual({
      id: 'message-1',
      text: 'Your flight is FI 614 on Friday.',
      parts: [],
    });
    expect(projected.messages[1]).toEqual(page.messages[1]);
  });

  it('keeps schema-one cards for capable clients and uses bounded typed fallback for future schemas', () => {
    const page = {
      messages: [{ id: 'message-1', text: '', parts: [{ type: 'data-card', data: card() }] }],
      refreshed: [{ id: 'message-2', text: '', parts: [{ type: 'data-card', data: card() }] }],
    };
    expect(projectMobileCardCapabilities(page, request('1')).messages).toEqual(page.messages);
    const future = projectMobileCardCapabilities(page, request('2'));
    expect(future.messages[0]).toMatchObject({
      id: 'message-1',
      text: 'Travel plan\nFlight: FI 614 on Friday',
      parts: [],
    });
    expect(JSON.stringify(future)).not.toContain('ABCD-1234');
    expect(future.refreshed[0]).toMatchObject({
      id: 'message-2',
      text: 'Travel plan\nFlight: FI 614 on Friday',
      parts: [],
    });
  });

  it('retains an unsupported card with accessible recovery text and no guessed facts', () => {
    const page = {
      messages: [
        {
          id: 'message-1',
          text: '',
          parts: [{ type: 'data-card', data: { ...card(2), spec: { version: 2 } } }],
        },
      ],
    };
    const projected = projectMobileCardCapabilities(page, request('1'));
    expect(projected.messages[0]).toMatchObject({
      id: 'message-1',
      text: 'This saved response cannot be displayed here. Ask the assistant to show it as text.',
      parts: page.messages[0]?.parts,
    });
    expect(projected.messages[0]?.text).not.toContain('ABCD-1234');
    expect(page.messages[0]?.text).toBe('');
  });
  it('keeps existing text parts for an unknown card instead of replacing their prose', () => {
    const page = {
      messages: [
        {
          id: 'message-1',
          text: '',
          parts: [
            { type: 'text', text: 'Existing verified answer.' },
            {
              type: 'data-card',
              data: {
                kind: 'generated-card',
                id: 'card-1',
                revisionId: 'revision-1',
                spec: {
                  version: 2,
                  privateData: 'opaque-private-value',
                  actions: [{ type: 'unknown-external-write' }],
                },
              },
            },
          ],
        },
      ],
    };
    const projected = projectMobileCardCapabilities(page, request('1'));
    expect(projected.messages[0]?.text).toBe('Existing verified answer.');
    expect(projected.messages[0]?.parts).toEqual(page.messages[0]?.parts);
  });
});

describe('native form projection negotiation', () => {
  it('keeps one safe form only for the exact complete-handler header', () => {
    const page = {
      messages: [
        { id: 'form-message', text: '', parts: [{ type: 'data-card', data: formCard() }] },
      ],
    };
    const withoutForms = projectMobileCardCapabilities(page, request('1'));
    expect(withoutForms.messages[0]?.parts).toEqual([]);
    expect(withoutForms.messages[0]?.text).toContain('Travel plan');

    const enabled = projectMobileCardCapabilities(page, request('1', 'card-form-v1'));
    expect(enabled.messages[0]?.parts).toEqual(page.messages[0]?.parts);

    const multiple = {
      messages: [
        {
          id: 'multiple-form-message',
          text: '',
          parts: [
            {
              type: 'data-card',
              data: {
                ...formCard(),
                spec: {
                  ...formCard().spec,
                  blocks: [
                    formCard().spec.blocks[0],
                    { ...formCard().spec.blocks[0], id: 'second-request' },
                  ],
                },
              },
            },
          ],
        },
      ],
    };
    const safeFallback = projectMobileCardCapabilities(multiple, request('1', 'card-form-v1'));
    expect(safeFallback.messages[0]?.parts).toEqual([]);
  });
});

describe('WEB14 mobile shared reference contract', () => {
  it('projects schema-valid but unresolved table cells to public fallback prose', () => {
    const data = card();
    data.spec.blocks = [
      { type: 'table', columns: ['A', 'B'], rows: [['flight', 'missing']] },
    ] as never;
    const page = { messages: [{ id: 'm', text: '', parts: [{ type: 'data-card', data }] }] };
    const result = projectMobileCardCapabilities(page, request('1'));
    expect(result.messages[0]?.parts).toEqual([]);
    expect(result.messages[0]?.text).toContain('FI 614 on Friday');
    expect(JSON.stringify(result)).not.toContain('ABCD-1234');
  });
  it('withholds unflagged sensitive facts and their repetitions in authored labels', () => {
    const data = card();
    data.spec.title = 'Travel plan ABCD-1234';
    data.spec.facts = data.spec.facts.map((fact) => ({ ...fact, sensitive: false }));
    const result = projectMobileCardCapabilities(
      { messages: [{ text: '', parts: [{ type: 'data-card', data }] }] },
      request('0'),
    );
    expect(JSON.stringify(result)).not.toContain('ABCD-1234');
    expect(result.messages[0]?.text).toContain('FI 614 on Friday');
  });
});

describe('negotiated native form capability', () => {
  it('keeps forms in the fallback path until the complete native form handler is declared', () => {
    const page = {
      messages: [
        { id: 'form-message', text: '', parts: [{ type: 'data-card', data: formCard() }] },
      ],
    };
    const projected = projectMobileCardCapabilities(page, request('1'));
    expect(projected.messages[0]?.parts).toEqual([]);
    expect(projected.messages[0]?.text).toContain('Travel plan');
    expect(projected.messages[0]?.text).not.toContain('ABCD-1234');
  });

  it('preserves a native form only for the exact negotiated form protocol', () => {
    const page = {
      messages: [
        { id: 'form-message', text: '', parts: [{ type: 'data-card', data: formCard() }] },
      ],
    };
    expect(projectMobileCardCapabilities(page, request('1', 'card-form-v1')).messages).toEqual(
      page.messages,
    );
    const unknownProtocol = projectMobileCardCapabilities(page, request('1', 'card-form-v2'));
    expect(unknownProtocol.messages[0]?.parts).toEqual([]);
  });

  it('propagates negotiation through bootstrap conversation projection', () => {
    const message = {
      id: 'form-message',
      text: '',
      parts: [{ type: 'data-card', data: formCard() }],
    };
    const page = { conversation: { messages: [message] } };
    expect(
      projectMobileCardCapabilities(page, request('1')).conversation.messages[0]?.parts,
    ).toEqual([]);
    expect(
      projectMobileCardCapabilities(page, request('1', 'card-form-v1')).conversation.messages,
    ).toEqual([message]);
  });
});
