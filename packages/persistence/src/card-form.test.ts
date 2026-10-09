import { describe, expect, it } from 'vitest';
import {
  CardFormSchema,
  CardFormSubmissionSchema,
  canonicalCardFormRequest,
  canonicalCardFormValues,
  findCardForm,
} from './card-form.js';

const definition = {
  type: 'form',
  id: 'meeting',
  title: 'Meeting details',
  serverAction: 'submit_owner_chat_turn',
  submitLabel: 'Review request',
  fields: [
    { id: 'date', type: 'date', label: 'Date', required: true },
    { id: 'attending', type: 'boolean', label: 'Attend', required: true },
    { id: 'notes', type: 'text', label: 'Notes' },
    {
      id: 'time',
      type: 'choice',
      label: 'Preferred time',
      options: [
        { id: 'morning', label: 'Morning' },
        { id: 'afternoon', label: 'Afternoon' },
      ],
    },
  ],
};
const form = CardFormSchema.parse(definition);
const request = {
  protocol: 'card-form-v1',
  conversationId: '00000000-0000-4000-8000-000000000001',
  cardId: '00000000-0000-4000-8000-000000000002',
  expectedRevisionId: '00000000-0000-4000-8000-000000000003',
  formId: 'meeting',
  operationId: '00000000-0000-4000-8000-000000000004',
  values: { date: '2028-02-29', attending: false },
  ownerMessageText: 'Please find a meeting time, but do not send invitations yet.',
};

describe('card form submission contract', () => {
  it('requires an owner-reviewed message and binds edits to retry identity', () => {
    const submission = CardFormSubmissionSchema.parse(request);
    const values = canonicalCardFormValues(form, submission.values);
    expect(values).not.toBeNull();
    if (!values) throw new Error('Expected valid values');
    expect(canonicalCardFormRequest(submission, values)).toContain(request.ownerMessageText);
    expect(canonicalCardFormRequest(submission, values)).not.toBe(
      canonicalCardFormRequest(
        { ...submission, ownerMessageText: 'Find a different time.' },
        values,
      ),
    );
    expect(
      CardFormSubmissionSchema.safeParse({ ...request, ownerMessageText: undefined }).success,
    ).toBe(false);
    expect(
      CardFormSubmissionSchema.safeParse({ ...request, ownerMessageText: '   ' }).success,
    ).toBe(false);
    expect(CardFormSubmissionSchema.safeParse({ ...request, action: 'send_email' }).success).toBe(
      false,
    );
  });

  it('preserves stable field identity when controls and values reorder', () => {
    const reordered = CardFormSchema.parse({
      ...definition,
      fields: [...definition.fields].reverse(),
    });
    const first = canonicalCardFormValues(form, {
      ...request.values,
      notes: '  Owner note  ',
      time: 'morning',
    });
    const second = canonicalCardFormValues(reordered, {
      time: 'morning',
      notes: 'Owner note',
      attending: false,
      date: '2028-02-29',
    });
    expect(second).toEqual(first);
    expect(first).toEqual({
      attending: false,
      date: '2028-02-29',
      notes: 'Owner note',
      time: 'morning',
    });
    expect(canonicalCardFormRequest(CardFormSubmissionSchema.parse(request), first ?? {})).toBe(
      canonicalCardFormRequest(CardFormSubmissionSchema.parse(request), second ?? {}),
    );
  });

  it.each(['2026-02-29', '2028-02-30', '2028-13-01', '0000-01-01', '2028-2-01', '２０２８-02-29'])(
    'rejects invalid or noncanonical calendar date %s',
    (date) => expect(canonicalCardFormValues(form, { date, attending: false })).toBeNull(),
  );

  it('rejects missing required answers, wrong types, unknown choices and private fields', () => {
    expect(canonicalCardFormValues(form, { date: '2028-02-29' })).toBeNull();
    expect(canonicalCardFormValues(form, { ...request.values, attending: 'false' })).toBeNull();
    expect(canonicalCardFormValues(form, { ...request.values, time: 'night' })).toBeNull();
    expect(canonicalCardFormValues(form, { ...request.values, extra: 'unbound' })).toBeNull();
    expect(canonicalCardFormValues(form, { ...request.values, notes: '  ' })).toEqual(
      request.values,
    );
    const privateForm = CardFormSchema.parse({
      ...definition,
      fields: definition.fields.map((field) => ({ ...field, sensitive: true })),
    });
    expect(canonicalCardFormValues(privateForm, request.values)).toBeNull();
  });

  it.each(['__proto__', 'prototype', 'constructor'])('rejects unsafe field/object key %s', (id) => {
    expect(
      CardFormSchema.safeParse({ ...definition, fields: [{ id, type: 'text', label: 'Value' }] })
        .success,
    ).toBe(false);
    expect(
      CardFormSubmissionSchema.safeParse({ ...request, values: JSON.parse(`{"${id}":"value"}`) })
        .success,
    ).toBe(false);
    expect(
      canonicalCardFormValues(form, Object.assign(JSON.parse(`{"${id}":"value"}`), request.values)),
    ).toBeNull();
  });

  it('bounds fields, choices, values and UTF-16 text length', () => {
    expect(
      CardFormSchema.safeParse({
        ...definition,
        fields: [...definition.fields, definition.fields[0]],
      }).success,
    ).toBe(false);
    expect(
      CardFormSchema.safeParse({
        ...definition,
        fields: [definition.fields[0], definition.fields[0]],
      }).success,
    ).toBe(false);
    const choice = definition.fields[3];
    expect(
      CardFormSchema.safeParse({
        ...definition,
        fields: [{ ...choice, options: [{ id: 'only', label: 'Only' }] }],
      }).success,
    ).toBe(false);
    expect(
      CardFormSchema.safeParse({
        ...definition,
        fields: [
          {
            ...choice,
            options: [
              { id: 'a', label: ' ' },
              { id: 'b', label: 'B' },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      CardFormSubmissionSchema.safeParse({
        ...request,
        values: { ...request.values, notes: '😀'.repeat(250) },
      }).success,
    ).toBe(true);
    expect(
      CardFormSubmissionSchema.safeParse({
        ...request,
        values: { ...request.values, notes: '😀'.repeat(251) },
      }).success,
    ).toBe(false);
    expect(
      CardFormSubmissionSchema.safeParse({
        ...request,
        values: { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' },
      }).success,
    ).toBe(false);
    expect(
      CardFormSubmissionSchema.safeParse({ ...request, ownerMessageText: 'a'.repeat(4001) })
        .success,
    ).toBe(false);
    expect(
      CardFormSubmissionSchema.safeParse({ ...request, ownerMessageText: '😀'.repeat(2000) })
        .success,
    ).toBe(true);
    expect(
      CardFormSubmissionSchema.safeParse({ ...request, ownerMessageText: '😀'.repeat(2001) })
        .success,
    ).toBe(false);
    expect(CardFormSchema.safeParse({ ...definition, title: '😀'.repeat(30) }).success).toBe(true);
    expect(CardFormSchema.safeParse({ ...definition, title: '😀'.repeat(31) }).success).toBe(false);
  });

  it('normalizes UUID case and rejects nonprotocol UUIDs', () => {
    const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(
      CardFormSubmissionSchema.parse({ ...request, operationId: operationId.toUpperCase() })
        .operationId,
    ).toBe(operationId);
    for (const invalid of [
      '00000000-0000-0000-0000-000000000000',
      'aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa',
    ])
      expect(CardFormSubmissionSchema.safeParse({ ...request, operationId: invalid }).success).toBe(
        false,
      );
  });
});

describe('persisted card form lookup', () => {
  it('finds exactly one form at top level or inside one section', () => {
    expect(findCardForm({ blocks: [definition] }, 'meeting')).toEqual(form);
    expect(
      findCardForm(
        { blocks: [{ type: 'section', title: 'Details', blocks: [definition] }] },
        'meeting',
      ),
    ).toEqual(form);
  });

  it('rejects ambiguous IDs, malformed forms and oversized block collections', () => {
    expect(findCardForm({ blocks: [definition, definition] }, 'meeting')).toBeNull();
    expect(
      findCardForm({ blocks: [{ ...definition, serverAction: 'send_email' }] }, 'meeting'),
    ).toBeNull();
    expect(findCardForm({ blocks: Array(13).fill(definition) }, 'meeting')).toBeNull();
    expect(
      findCardForm({ blocks: [{ type: 'section', blocks: Array(7).fill(definition) }] }, 'meeting'),
    ).toBeNull();
    expect(
      findCardForm({ blocks: [{ type: 'section', blocks: null }, definition] }, 'meeting'),
    ).toBeNull();
  });

  it('rejects nested sections without traversing a circular object graph', () => {
    const nested: { type: string; blocks: unknown[] } = { type: 'section', blocks: [] };
    nested.blocks.push(nested);
    expect(findCardForm({ blocks: [nested, definition] }, 'meeting')).toBeNull();
    expect(
      findCardForm(
        { blocks: [{ type: 'section', blocks: [{ type: 'section', blocks: [definition] }] }] },
        'meeting',
      ),
    ).toBeNull();
  });
});
