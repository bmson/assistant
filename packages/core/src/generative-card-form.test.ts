import { describe, expect, it } from 'vitest';
import { GenerativeCardSpecV1Schema, validateGroundedCard } from './generative-card.js';

const form = {
  type: 'form' as const,
  id: 'meeting',
  title: 'Meeting details',
  serverAction: 'submit_owner_chat_turn' as const,
  submitLabel: 'Continue',
  warningFactIds: [],
  fields: [{ id: 'date', type: 'date' as const, label: 'Date', required: true, sensitive: false }],
};
const dateFact = { id: 'date', value: '2026-10-10', label: 'Date', source: 'Owner' };
const card = (blocks: unknown[], facts = [dateFact]) => ({
  version: 1,
  title: 'Meeting',
  icon: 'calendar',
  accent: 'sky',
  accessibilityLabel: 'Meeting details',
  sourceLabel: 'Owner',
  facts,
  blocks,
  actions: [],
  refreshable: false,
});
const parsedCard = (blocks: unknown[], facts = [dateFact]) =>
  GenerativeCardSpecV1Schema.parse(card(blocks, facts));

describe('generative card form block', () => {
  it('accepts the fixed owner-submit action at top level and inside one section', () => {
    expect(GenerativeCardSpecV1Schema.safeParse(card([form])).success).toBe(true);
    expect(
      GenerativeCardSpecV1Schema.safeParse(
        card([{ type: 'section', title: 'Details', blocks: [form] }]),
      ).success,
    ).toBe(true);
  });
  it('rejects an unrecognized form action through the shared persistence schema', () => {
    expect(
      GenerativeCardSpecV1Schema.safeParse(card([{ ...form, serverAction: 'send_email' }])).success,
    ).toBe(false);
  });
  it('grounds warning/default references and omits sensitive or secret-labeled forms', () => {
    const corpus = 'Meeting date 2026-10-10';
    const referenced = {
      ...form,
      warningFactIds: ['date'],
      fields: [{ ...form.fields[0], defaultFact: 'date' }],
    };
    expect(validateGroundedCard(parsedCard([referenced]), corpus)?.blocks).toHaveLength(1);
    expect(
      validateGroundedCard(parsedCard([{ ...referenced, warningFactIds: ['missing'] }]), corpus),
    ).toBeNull();
    const secret = {
      id: 'secret',
      value: 'owner-secret-token',
      label: 'Token',
      source: 'Owner',
      sensitive: true,
    };
    const withSecret = [dateFact, secret];
    expect(
      validateGroundedCard(
        parsedCard([{ ...referenced, warningFactIds: ['secret'] }], withSecret),
        `${corpus} owner-secret-token`,
      ),
    ).toBeNull();
    expect(
      validateGroundedCard(
        parsedCard([{ ...referenced, title: 'owner-secret-token' }], withSecret),
        `${corpus} owner-secret-token`,
      ),
    ).toBeNull();
  });
});
