import { CardFormSchema } from '@assistant/persistence/card-form';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardFormBlock } from './card-form-block';

function stripMarkup(markup: string) {
  return markup.replace(/<[^>]*>/g, '');
}

const form = CardFormSchema.parse({
  type: 'form',
  id: 'trip',
  title: 'Trip details',
  serverAction: 'submit_owner_chat_turn',
  submitLabel: 'Send request',
  warningFactIds: ['warning'],
  fields: [
    { id: 'date', type: 'date', label: 'Departure date', required: true },
    { id: 'arrive', type: 'boolean', label: 'Tell the host I will arrive', required: false },
  ],
});

describe('inline card form', () => {
  it('shows source warnings and labeled controls with review-only affordance', () => {
    const markup = renderToStaticMarkup(
      <CardFormBlock
        form={form}
        identity={{
          conversationId: '11111111-1111-4111-8111-111111111111',
          cardId: '22222222-2222-4222-8222-222222222222',
          revisionId: '33333333-3333-4333-8333-333333333333',
          formId: 'trip',
        }}
        values={{ date: '2026-10-09', arrive: false }}
        warningFacts={[{ id: 'warning', label: 'Check-in', value: 'After 3 PM' }]}
        editable
        onReview={() => {}}
      />,
    );
    expect(stripMarkup(markup)).toContain('Check-in: After 3 PM');
    expect(markup).toContain('Departure date');
    expect(markup).toContain('Tell the host I will arrive');
    expect(markup).toContain('Review in message');
    expect(markup).not.toContain('Send request');
    expect(markup).not.toContain('<form');
  });

  it('offers Yes and No for a required boolean so a valid false answer is selectable', () => {
    const requiredBoolean = CardFormSchema.parse({
      ...form,
      fields: [{ id: 'confirmed', type: 'boolean', label: 'Confirmed', required: true }],
    });
    const markup = renderToStaticMarkup(
      <CardFormBlock
        form={requiredBoolean}
        identity={{
          conversationId: '11111111-1111-4111-8111-111111111111',
          cardId: '22222222-2222-4222-8222-222222222222',
          revisionId: '33333333-3333-4333-8333-333333333333',
          formId: 'trip',
        }}
        values={{ confirmed: false }}
        warningFacts={[]}
        editable
        onReview={() => {}}
      />,
    );
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('>Yes</label>');
    expect(markup).toContain('>No</label>');
    expect(markup).toContain('checked=""');
    expect(markup).not.toContain('<form');
  });

  it('preserves warning context when the complete composer path is unavailable', () => {
    const markup = renderToStaticMarkup(
      <CardFormBlock
        form={form}
        identity={null}
        values={{}}
        warningFacts={[{ id: 'warning', label: 'Check-in', value: 'After 3 PM' }]}
        editable={false}
      />,
    );
    expect(stripMarkup(markup)).toContain('Check-in: After 3 PM');
    expect(markup).toContain('cannot be filled in this chat view');
    expect(markup).not.toContain('Review in message');
  });
});
