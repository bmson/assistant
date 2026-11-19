import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { householdDayFixture } from './calendar-household-day.test-fixtures';
import { ResponseCards } from './response-card';

type Raw = Record<string, unknown>;
const render = (card: Raw) =>
  renderToStaticMarkup(<ResponseCards cards={[card]} timeZone="America/Los_Angeles" />);
const agendaItems = (card: Raw) => ((card.sections as Raw[])[0] as Raw).items as Raw[];

describe('read-only household agenda rendering (synthetic)', () => {
  it('puts decisive coverage and unknown freshness before the supported question and rows', () => {
    const html = render(householdDayFixture());
    expect(html.indexOf('Coverage incomplete:')).toBeLessThan(html.indexOf('Next question'));
    expect(html.indexOf('Source freshness unavailable.')).toBeLessThan(
      html.indexOf('Next question'),
    );
    expect(html.indexOf('Next question')).toBeLessThan(html.indexOf('Agenda items'));
    expect(html).toContain('2 other calendar pair');
    expect(html).toContain('Showing 2 of 2');
    expect(html).not.toContain('Save interpretation');
    expect(html).not.toContain('Mark as');
  });

  it('keeps source RSVP independent from the unknown person and driver', () => {
    const card = householdDayFixture();
    const item = agendaItems(card)[1] as Raw;
    const details = item.householdDetails as Raw;
    (details.sources as Raw[]).push({
      ...(details.sources as Raw[])[0],
      calendar: 'Second source',
      rsvp: 'declined',
    });
    item.note = 'Your RSVP differs by calendar source.';
    delete (card.householdDay as Raw).nextQuestion;
    const html = render(card);
    expect(html).toContain('Your RSVP differs by calendar source.');
    expect(html).toContain('Your RSVP: accepted');
    expect(html).toContain('Your RSVP: declined');
    expect(html).toContain('Maya’s lesson');
    expect(html).toContain('Not stated');
    expect(html).toContain(
      'A calendar RSVP does not confirm attendance or driving responsibility.',
    );
    expect(html).not.toContain('Next question');
    expect(html).not.toContain('For Maya');
  });

  it.each([
    ['unknown version', { version: 2 }],
    ['partial coverage', { version: 1, coverage: { complete: true } }],
    ['malformed', 'not a projection'],
  ])('preserves the original agenda and coverage for %s optional data', (_name, projection) => {
    const card = householdDayFixture();
    card.householdDay = projection;
    const html = render(card);
    expect(html).toContain('Synthetic workshop');
    expect(html).toContain('Showing 2 of 2');
    expect(html).toContain('Calendar read coverage');
    expect(html).toContain('Coverage incomplete');
    expect(html).not.toContain('Next question');
  });

  it('does not show a question without its supported owner relevance basis', () => {
    const card = householdDayFixture();
    const projection = card.householdDay as Raw;
    (projection.nextQuestion as Raw).basis = 'family-calendar-name';
    const html = render(card);
    expect(html).not.toContain('Next question');
    expect(html).toContain('Calendar read coverage');
    expect(html).toContain('Your RSVP: accepted.');
  });

  it.each(['declined', 'not_verified', 'unknown', 'tentative'])(
    'suppresses a stale accepted-overlap question when linked evidence includes %s',
    (rsvp) => {
      const card = householdDayFixture();
      const item = agendaItems(card)[1] as Raw;
      const details = item.householdDetails as Raw;
      (details.sources as Raw[]).push({
        ...(details.sources as Raw[])[0],
        calendar: 'Conflicting or unverified source',
        rsvp,
      });
      item.note = 'Your RSVP differs by calendar source.';
      // Deliberately retain the old schema-valid nextQuestion in this payload.
      const html = render(card);
      expect(html).not.toContain('Next question');
      expect(html).toContain('Your RSVP differs by calendar source.');
      expect(html).toContain('Checked calendar coverage');
      expect(html).toContain('Showing 2 of 2');
    },
  );

  it.each(['missing', 'duplicate', 'same-target'])(
    'does not guess a comparison target when the pair is %s',
    (kind) => {
      const card = householdDayFixture();
      delete (card.householdDay as Raw).nextQuestion;
      const attention = (card.sections as Raw[])[1] as Raw;
      const comparison = ((attention.items as Raw[])[0] as Raw).comparison as Raw;
      if (kind === 'missing') comparison.rightEventId = 'absent';
      if (kind === 'duplicate') agendaItems(card).push({ ...agendaItems(card)[1] });
      if (kind === 'same-target') comparison.rightEventId = comparison.leftEventId;
      const html = render(card);
      expect(html).not.toContain('Compare listings');
      expect(html).toContain('Source times differ');
      expect(html).toContain('Both source listings remain visible');
      expect(html).toContain('Synthetic workshop');
    },
  );

  it('keeps valid exact-pair comparison read-only and preserves the original row count', () => {
    const card = householdDayFixture();
    delete (card.householdDay as Raw).nextQuestion;
    const html = render(card);
    expect(html).toContain('Compare listings');
    expect(html).toContain('Both listings remain in the agenda with their source times.');
    expect(html).toContain('Source time zone: America/Los_Angeles');
    expect(html).toContain('Showing 2 of 2');
    expect(html).not.toContain('Merge');
    expect(html).not.toContain('Save');
    expect(html).not.toContain('series');
  });

  it('preserves the old row if its optional detail shape is malformed', () => {
    const card = householdDayFixture();
    delete (card.householdDay as Raw).nextQuestion;
    (agendaItems(card)[0] as Raw).householdDetails = { version: 99 };
    const html = render(card);
    expect(html).toContain('Synthetic workshop');
    expect(html).toContain('Your RSVP: accepted.');
    expect(html).not.toContain('Details for Synthetic workshop');
    expect(html).not.toContain('Compare listings');
  });
});
