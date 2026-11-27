import { describe, expect, it } from 'vitest';
import {
  attributeMemoryPerson,
  groundMemoryPersonReference,
  groundPersonEvidence,
  isCurrentMemoryPersonEvidence,
  personNameInferredFromSubject,
  personSourceTextHash,
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
    expect(
      attributeMemoryPerson([target, other], {
        ...input,
        subject: 'Avery Junior',
        evidence: groundMemoryPersonReference('Avery Junior', 'Avery Junior wants paper tickets.'),
      }),
    ).toEqual({
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

  it.each([
    ['Copper Lantern', 'Copper Lantern is a community center that opens on Saturdays.'],
    ['Orchid Press', 'Orchid Press is a teacher training program.'],
    ['West Garden', 'West Garden is my sister school.'],
    ['Kalliope Cooperative', 'Kalliope Cooperative operates the ferry route.'],
    ['Copper', 'My daughter Copper Lantern is visiting.'],
    ['Avery Ng', 'Avery Ng is my sister. Avery Ng is not a person.'],
    ['Avery Ng', 'Avery Ng is another person with the same name.'],
    ['Avery Ng', 'Avery Ng is my sister in the play.'],
    ['Avery Ng', 'The boat Avery Ng sank in the harbor.'],
    ['Avery Ng', 'Avery Ng is a river that passes downtown.'],
    ['Avery Ng', 'A coworker told me: Avery Ng is my sister.'],
    ['Avery Ng', 'A coworker wrote the following. Avery Ng is my sister.'],
    ['Avery Ng', 'Here is an example. Avery Ng is my sister.'],
    ['Avery Ng', 'Avery Ng is my sister, according to an email.'],
    ['Avery Ng', 'Avery Ng is my daughter, says my coworker.'],
    ['Avery Ng', 'Avery Ng is my daughter, my coworker said.'],
    ['Avery Ng', 'Avery Ng is my daughter. This is only an example.'],
    ['Avery Ng', 'Take this as a joke. Avery Ng is my daughter.'],
    ['Avery Ng', 'Avery Ng is my daughter. Do not save this.'],
    ['Avery Ng', 'Do not save this. Avery Ng is my daughter.'],
    ['Avery Ng', 'Avery Ng is my daughter. Never save it.'],
    ['Avery Ng', 'Never save it. Avery Ng is my daughter.'],
    ['Avery Ng', 'Avery Ng is not the Avery Ng you know.'],
    ['Avery Ng', 'Avery Ng Jr. is a human.'],
    ['Avery Ng', 'Avery Ng Orchestra performs on Friday.'],
    ['Avery Ng', 'Avery Ng has a daughter organization.'],
  ])('keeps an unsupported entity reference to %s unattributed', (subject, content) => {
    expect(attributeMemoryPerson([], { subject, content })).toEqual({ kind: 'unattributed' });
    if (subject === target.name) {
      expect(attributeMemoryPerson([target], { subject, content })).toEqual({
        kind: 'unattributed',
      });
    }
  });

  it.each([
    ['Luljeta Gjoka', 'Luljeta Gjoka is my former coworker.'],
    ['Aino Väisänen', 'My only sibling is named Aino Väisänen.'],
    ['Aino Väisänen', 'Aino Väisänen has a daughter.'],
    ['Aino Väisänen', 'Aino Väisänen works as a dentist.'],
    ['朴 素妍', '朴 素妍 is my neighbor.'],
    ['Élín', 'My friend Élín’s birthday is June 9.'],
    ['Avery Ng', 'Avery Ng is my daughter. She gave an example of a favorite recipe.'],
    ['Avery Ng', 'Avery Ng is my daughter. She told a joke about breakfast.'],
    ['Avery Ng', 'Avery Ng is my daughter. Do not save this file.'],
  ])('creates %s from affirmative evidence of personhood', (subject, content) => {
    expect(attributeMemoryPerson([], { subject, content })).toEqual({
      kind: 'create',
      name: subject,
    });
  });

  it.each([
    'My daughter goes by Robin, short for Robin Shaw. Her email is robin@example.test.',
    'My daughter goes by Robin, short for Robin Shaw, whose email is robin@example.test.',
    'My daughter Robin Shaw is known as Robin, and her email address is robin@example.test',
  ])('grounds natural names and contact details in one owner statement', (quote) => {
    const evidence = groundPersonEvidence({ canonicalName: 'Robin Shaw', quote }, 'Robin', [quote]);
    const saved = { ...target, name: 'Robin Shaw', emails: ['robin@example.test'], aliases: [] };
    const content = 'The daughter also uses a nickname.';
    expect(evidence).toEqual({
      canonicalName: saved.name,
      relationship: 'daughter',
      identifiers: ['email:robin@example.test'],
    });
    expect(attributeMemoryPerson([saved], { subject: 'Robin', content, evidence })).toMatchObject({
      kind: 'identified',
      contactId: saved.id,
      update: { aliases: ['Robin'] },
    });
    expect(
      attributeMemoryPerson([saved, { ...saved, id: 'other' }], {
        subject: 'Robin',
        content,
        evidence,
      }),
    ).toEqual({ kind: 'unattributed' });
  });

  it.each([
    'My daughter goes by Robin, short for Robin Shaw. His email is robin@example.test.',
    'My daughter goes by Robin, short for Robin Shaw. Her phone is robin@example.test.',
    'My daughter goes by Robin, short for Robin Shaw. My sister’s email is robin@example.test.',
    'Robin Shaw goes by Robin. Her email is robin@example.test. His phone is +1 (202) 555-0123.',
    'My daughter Robin Shaw goes by Robin.',
    'Suppose my daughter Robin Shaw goes by Robin. Her email is robin@example.test.',
  ])('requires a matching referent and channel in %s', (quote) => {
    const proposal = { canonicalName: 'Robin Shaw', quote };
    expect(groundPersonEvidence(proposal, 'Robin', [quote])).toBeNull();
    expect(groundMemoryPersonReference('Robin', quote)).toBeUndefined();
  });

  it('preserves direct references to confirmed people and rejects later conflicting addresses', () => {
    const saved = { ...target, emails: ['avery@example.test'] };
    const withContent = (content: string) =>
      attributeMemoryPerson([saved], {
        content,
        subject: saved.name,
      });
    expect(withContent('I spoke with Avery Ng at the library.')).toEqual({
      kind: 'identified',
      contactId: saved.id,
    });
    for (const content of [
      'Avery Ng is my daughter. Her email is other@example.test. She lives across town.',
      'Avery Ng is my daughter, but her email is other@example.test.',
      'Avery Ng is my daughter but her email is other@example.test.',
    ]) {
      expect(withContent(content)).toEqual({ kind: 'unattributed' });
    }
  });

  it('requires the latest complete owner assertion and unchanged source bytes', () => {
    const proposal = { canonicalName, quote };
    expect(
      groundPersonEvidence(proposal, subject, [quote, 'Those records are different.']),
    ).toBeNull();
    const grounded = groundPersonEvidence(proposal, subject, [quote]);
    if (!grounded) throw new Error('Missing grounded evidence');
    const source = { id: 'message', role: 'user', origin: 'owner', text: quote };
    const evidence = {
      ...grounded,
      sourceMessageId: source.id,
      sourceTextHash: personSourceTextHash(quote),
    };
    expect(isCurrentMemoryPersonEvidence(evidence, source)).toBe(true);
    expect(isCurrentMemoryPersonEvidence(evidence, { ...source, text: ` ${quote}` })).toBe(false);
    expect(isCurrentMemoryPersonEvidence(evidence, { ...source, origin: 'web' })).toBe(false);
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
