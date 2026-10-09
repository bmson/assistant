import { CardFormSchema } from '@assistant/persistence/card-form';
import { describe, expect, it } from 'vitest';
import { prepareOwnerCardFormTurn } from './card-form-admission.js';

const facts = [
  { id: 'date', value: '2026-10-10', label: 'Date', source: 'Owner', sensitive: false },
  { id: 'token', value: 'owner-secret-token', label: 'Token', source: 'Owner', sensitive: true },
];
const form = CardFormSchema.parse({
  type: 'form',
  id: 'meeting',
  title: 'Meeting details',
  serverAction: 'submit_owner_chat_turn',
  submitLabel: 'Continue',
  warningFactIds: ['date'],
  fields: [
    {
      id: 'date',
      type: 'date',
      label: 'Date',
      required: true,
      sensitive: false,
      defaultFact: 'date',
    },
    {
      id: 'time',
      type: 'choice',
      label: 'Time',
      required: true,
      sensitive: false,
      options: [
        { id: 'am', label: 'Morning' },
        { id: 'pm', label: 'Afternoon' },
      ],
    },
  ],
});
const ownerMessageText = 'Could you check whether October 10 works for the meeting?';
const spec = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  title: 'Meeting',
  icon: 'calendar',
  accent: 'sky',
  accessibilityLabel: 'Meeting',
  sourceLabel: 'Owner',
  facts,
  blocks: [form],
  actions: [],
  refreshable: false,
  ...overrides,
});

describe('server-owned card form preparation', () => {
  it('preserves reviewed owner text while validating typed form answers', () => {
    const prepared = prepareOwnerCardFormTurn({
      revisionSpec: spec(),
      form,
      values: { date: '2026-10-10', time: 'am' },
      ownerMessageText,
    });
    expect(prepared?.ownerMessageText).toBe(ownerMessageText);
    expect(prepared?.ownerMessageText).not.toContain('owner-secret-token');
  });
  it('fails closed for missing or sensitive references and unsafe labels/values', () => {
    const unsafeForms = [
      { ...form, warningFactIds: ['missing'] },
      { ...form, warningFactIds: ['token'] },
      { ...form, fields: [{ ...form.fields[0], defaultFact: 'token' }, form.fields[1]] },
      { ...form, fields: [{ ...form.fields[0], label: 'owner-secret-token' }, form.fields[1]] },
      { ...form, fields: [{ ...form.fields[0], sensitive: true }, form.fields[1]] },
    ].map((candidate) => CardFormSchema.parse(candidate));
    for (const unsafeForm of unsafeForms) {
      expect(
        prepareOwnerCardFormTurn({
          revisionSpec: spec({ blocks: [unsafeForm] }),
          form: unsafeForm,
          values: { date: '2026-10-10', time: 'am' },
          ownerMessageText,
        }),
      ).toBeNull();
    }
    expect(
      prepareOwnerCardFormTurn({
        revisionSpec: spec(),
        form,
        values: { date: 'owner-secret-token', time: 'am' },
        ownerMessageText,
      }),
    ).toBeNull();
    expect(
      prepareOwnerCardFormTurn({
        revisionSpec: spec(),
        form,
        values: { date: '2026-10-10', time: 'am' },
        ownerMessageText: 'Please send owner-secret-token.',
      }),
    ).toBeNull();
  });
});
