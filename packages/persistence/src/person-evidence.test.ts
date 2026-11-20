import { describe, expect, it } from 'vitest';
import {
  attributeMemoryPerson,
  groundPersonEvidence,
  personNameInferredFromSubject,
} from './person-evidence.js';

const subject = "owner's child Avery Ng";
const canonicalName = 'Avery Ng';
const quote = `The record "${subject}" belongs to my daughter ${canonicalName} (+1 (202) 555-0123).`;
const target = {
  id: 'daughter',
  name: canonicalName,
  trust: 'known',
  identityAuthority: 'owner' as const,
  relationship: 'daughter',
  aliases: ['Avery Junior'],
  emails: [],
  phones: ['+12025550123'],
  notes: 'Original note',
};
const source = {
  ...target,
  id: 'old-record',
  name: subject,
  trust: 'unknown',
  identityAuthority: 'inferred' as const,
  relationship: 'child',
  aliases: ['A. Ng'],
  notes: 'Legacy note',
};

describe('memory person evidence', () => {
  it('accepts either the complete remembered statement or its quoted assertion', () => {
    const message = `Please remember that ${quote}`;
    const expected = {
      canonicalName,
      identifiers: ['phone:12025550123'],
      relationship: 'daughter',
    };
    expect(groundPersonEvidence({ canonicalName, quote }, subject, [message])).toEqual(expected);
    expect(groundPersonEvidence({ canonicalName, quote: message }, subject, [message])).toEqual(
      expected,
    );
    expect(groundPersonEvidence({ canonicalName, quote: message }, subject, [quote])).toBeNull();
  });

  it.each([
    `Suppose ${quote}`,
    `A coworker wrote the following. ${quote}`,
    `${quote} That was incorrect. These are different people.`,
    `${quote} This is only an example. Never save it.`,
    `"${quote}"`,
  ])('rejects a statement embedded in %s', (message) => {
    expect(groundPersonEvidence({ canonicalName, quote }, subject, [message])).toBeNull();
  });

  it('reconciles an inferred record with the unshared saved phone and retains aliases', () => {
    const evidence = groundPersonEvidence({ canonicalName, quote }, subject, [quote]);
    const input = { subject, evidence, content: 'A synthetic durable fact.' };
    expect(attributeMemoryPerson([source, target], input)).toEqual({
      kind: 'identified',
      contactId: target.id,
      update: {
        duplicateId: source.id,
        aliases: ['Avery Junior', 'A. Ng', subject],
        phones: target.phones,
        emails: [],
        notes: 'Original note\nLegacy note',
      },
    });
    expect(attributeMemoryPerson([source, target, { ...target, id: 'other' }], input)).toEqual({
      kind: 'unattributed',
    });
    expect(
      attributeMemoryPerson([source, target], {
        ...input,
        content: 'This person uses a separate address at other@example.test.',
      }),
    ).toEqual({ kind: 'unattributed' });
  });

  it('keeps ordinary known aliases and fails closed on typed homonyms', () => {
    const input = { subject: canonicalName, content: 'Ask the school at school@example.test.' };
    const other = { ...target, id: 'other', aliases: [] };
    expect(attributeMemoryPerson([target, other], { ...input, subject: 'Avery Junior' })).toEqual({
      kind: 'identified',
      contactId: target.id,
    });
    expect(attributeMemoryPerson([target, other], { ...input, knownContactId: target.id })).toEqual(
      {
        kind: 'unattributed',
      },
    );
  });

  it('rejects a conflicting identifier attached to a subject in ordinary facts', () => {
    const contact = { ...target, emails: ['avery.owner@example.test'] };
    const conflict = {
      subject: canonicalName,
      content: `A different ${canonicalName} uses avery.other@example.test.`,
    };
    expect(attributeMemoryPerson([contact], conflict)).toEqual({ kind: 'unattributed' });
    expect(attributeMemoryPerson([contact], { ...conflict, knownContactId: contact.id })).toEqual({
      kind: 'unattributed',
    });
    expect(
      attributeMemoryPerson([contact], {
        ...conflict,
        content: `${canonicalName} likes school and the school uses admin@example.test.`,
      }),
    ).toEqual({ kind: 'identified', contactId: contact.id });
  });

  it('retains multilingual names and refuses inventory and sentence-like subjects', () => {
    expect(personNameInferredFromSubject('李 明')).toBe('李 明');
    expect(personNameInferredFromSubject('Aino Väisänen')).toBe('Aino Väisänen');
    expect(personNameInferredFromSubject('Ana M. da Silva')).toBe('Ana M. da Silva');
    expect(personNameInferredFromSubject('qa85p2')).toBeNull();
    expect(personNameInferredFromSubject('The warehouse door is blue.')).toBeNull();
    expect(
      personNameInferredFromSubject('Blue', 'Blue is the warehouse inventory code.'),
    ).toBeNull();
  });
});
