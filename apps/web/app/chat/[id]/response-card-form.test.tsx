import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResponseCards, rendersAllCards, rendersSomeCards } from './response-card';

const card = {
  kind: 'generated-card',
  id: '22222222-2222-4222-8222-222222222222',
  revisionId: '33333333-3333-4333-8333-333333333333',
  spec: {
    version: 1,
    title: 'Dinner plan',
    icon: 'generic',
    facts: [{ id: 'warning', label: 'Timing', value: 'Reservation is at 7 PM' }],
    blocks: [
      {
        type: 'form',
        id: 'dinner',
        title: 'Dinner details',
        serverAction: 'submit_owner_chat_turn',
        submitLabel: 'Send booking',
        warningFactIds: ['warning'],
        fields: [{ id: 'guests', type: 'text', label: 'Number of guests', required: true }],
      },
    ],
    actions: [],
  },
};
const conversationId = '11111111-1111-4111-8111-111111111111';
const formSessionScope = 'synthetic-form-session-0001';
const visibleText = (markup: string) => markup.replace(/<[^>]*>/g, '');
const callbacks = { onChangeForm: () => {}, onReviewForm: () => {} };

describe('generated card form integration capability', () => {
  it('preserves prose fallback and warning facts when the composer path is unavailable', () => {
    expect(rendersSomeCards([card])).toBe(true);
    expect(rendersAllCards([card])).toBe(false);
    const markup = renderToStaticMarkup(<ResponseCards cards={[card]} timeZone="UTC" />);
    expect(visibleText(markup)).toContain('Timing: Reservation is at 7 PM');
    expect(markup).toContain('cannot be filled in this chat view');
    expect(markup).not.toContain('Review in message');
  });

  it('reports full support only when a valid card identity and owner composer callbacks are connected', () => {
    expect(rendersAllCards([card], { onCardFormReviewAvailable: true })).toBe(true);
    const markup = renderToStaticMarkup(
      <ResponseCards
        cards={[card]}
        timeZone="UTC"
        conversationId={conversationId}
        formSessionScope={formSessionScope}
        {...callbacks}
      />,
    );
    expect(markup).toContain('Review in message');
    expect(markup).toContain('Number of guests');
    expect(
      renderToStaticMarkup(
        <ResponseCards
          cards={[{ ...card, revisionId: 'not-a-revision' }]}
          timeZone="UTC"
          conversationId={conversationId}
          formSessionScope={formSessionScope}
          {...callbacks}
        />,
      ),
    ).toContain('cannot be filled in this chat view');
  });

  it('requires authenticated session scope for Review and propagates it through preview and overflow cards', () => {
    const withoutScope = renderToStaticMarkup(
      <ResponseCards
        cards={[card]}
        timeZone="UTC"
        conversationId={conversationId}
        {...callbacks}
      />,
    );
    expect(visibleText(withoutScope)).toContain('cannot be filled in this chat view');
    expect(withoutScope).not.toContain('Review in message');

    const overflowCards = Array.from({ length: 4 }, (_, index) => ({
      ...card,
      id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
    }));
    const withScope = renderToStaticMarkup(
      <ResponseCards
        cards={overflowCards}
        timeZone="UTC"
        conversationId={conversationId}
        formSessionScope={formSessionScope}
        {...callbacks}
      />,
    );
    expect(withScope.match(/Review in message/g)).toHaveLength(4);
  });

  it('keeps an old revision draft visible and requires an explicit carry or clear choice', () => {
    const markup = renderToStaticMarkup(
      <ResponseCards
        cards={[card]}
        timeZone="UTC"
        conversationId={conversationId}
        formSessionScope={formSessionScope}
        formDraft={{
          version: 1,
          identity: {
            conversationId,
            cardId: card.id,
            revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            formId: 'dinner',
          },
          values: { guests: '4' },
        }}
        onChangeForm={() => {}}
        onReviewForm={() => {}}
        onCarryForm={() => {}}
        onDiscardForm={() => {}}
      />,
    );
    expect(markup).toContain('4');
    expect(visibleText(markup)).toContain('This card has a newer version.');
    expect(markup).toContain('Carry compatible answers');
    expect(markup).toContain('Clear saved answers');
    expect(markup).not.toContain('Review in message');
  });
});
