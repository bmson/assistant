import type { OwnerEditorApply } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { ownerEditorRequestHash } from './owner-editor-hash.js';
import { isOwnerEditorCivilDay, parseOwnerEditorRequest } from './owner-editor-wire.js';

const people = '/api/people/editor';
const family = '/api/profile/knowledge/family';
const operationId = '00000000-0000-4000-8000-000000000001';
const subject = '00000000-0000-4000-8000-000000000002';
const object = '00000000-0000-4000-8000-000000000003';
const revision = 'a'.repeat(64);
const add = {
  version: 1,
  intent: 'apply',
  command: 'add_family_relationship',
  operationId,
  subjectContactId: subject,
  objectContactId: object,
  expectedSubjectRevision: revision,
  expectedObjectRevision: revision,
  predicate: 'partner_of',
  timing: 'unspecified',
  validity: { validFrom: null, validUntil: null },
  note: '',
  expectedCanonicalState: { kind: 'absent' },
};

describe('owner editor civil meaning and strict wire boundary', () => {
  it.each([
    ['2000-02-29', true],
    ['1900-02-29', false],
    ['2100-02-29', false],
    ['2024-02-29', true],
    ['2025-02-29', false],
    ['2026-04-31', false],
    ['2026-00-01', false],
    ['2026-13-01', false],
    ['2026-01-00', false],
    ['2999-12-31', true],
    ['0999-12-31', false],
    ['3000-01-01', false],
    ['2026-02', false],
    ['2026-02-01T00:00:00Z', false],
  ])('validates %s without date rollover', (day, expected) => {
    expect(isOwnerEditorCivilDay(day)).toBe(expected);
  });

  it.each([
    { validFrom: null, validUntil: null },
    { validFrom: '2024-02-29', validUntil: '2024-02-29' },
    { validFrom: null, validUntil: '2024-02-29' },
    { validFrom: '2999-01-01', validUntil: null },
  ])(
    'retains exact nullable/equal/end-only/future civil dates and explicit meaning',
    (validity) => {
      const result = parseOwnerEditorRequest({ ...add, validity }, family);
      expect(result.ok).toBe(true);
      if (
        result.ok &&
        result.request.intent === 'apply' &&
        result.request.command === 'add_family_relationship'
      ) {
        expect(result.request.validity).toEqual(validity);
        expect(result.request.timing).toBe('unspecified');
      }
    },
  );

  it('rejects reversed bounds, missing correction bounds and impossible precision', () => {
    for (const validity of [
      { validFrom: '2026-02-02', validUntil: '2026-02-01' },
      { validFrom: '2026-02-30', validUntil: null },
      { validFrom: null },
      { validFrom: '2026-02', validUntil: null },
    ])
      expect(parseOwnerEditorRequest({ ...add, validity }, family).ok).toBe(false);
    const { version, intent, command, operationId: op, ...replacement } = add;
    expect(
      parseOwnerEditorRequest(
        {
          version,
          intent,
          command: 'correct_owner_family_relationship',
          operationId: op,
          targetRelationId: object,
          expectedTargetRevision: revision,
          replacement: { ...replacement, validity: { validUntil: null } },
        },
        family,
      ).ok,
    ).toBe(false);
    expect(command).toBe('add_family_relationship');
  });

  it('requires distinct exact contacts and compatible explicit former meaning', () => {
    expect(
      parseOwnerEditorRequest({ ...add, objectContactId: subject.toUpperCase() }, family).ok,
    ).toBe(false);
    expect(parseOwnerEditorRequest({ ...add, predicate: 'former_spouse_of' }, family).ok).toBe(
      false,
    );
    expect(
      parseOwnerEditorRequest({ ...add, predicate: 'former_spouse_of', timing: 'past' }, family).ok,
    ).toBe(true);
    expect(parseOwnerEditorRequest({ ...add, timing: 'future' }, family).ok).toBe(false);
    expect(parseOwnerEditorRequest({ ...add, predicate: 'works_at' }, family).ok).toBe(false);
  });

  it('rejects new authority fields, wrong routes and silent note truncation', () => {
    for (const extra of [
      { trust: 'known' },
      { ownerId: subject },
      { formSessionScope: 'x' },
      { 'X-Editor-Form-Scope': 'x' },
      { actionId: 'other' },
    ]) {
      expect(parseOwnerEditorRequest({ ...add, ...extra }, family).ok).toBe(false);
    }
    expect(parseOwnerEditorRequest(add, people).ok).toBe(false);
    expect(parseOwnerEditorRequest({ ...add, note: 'x'.repeat(1001) }, family).ok).toBe(false);
  });

  it('reuses canonical name/alias rules and refuses trust-changing identity input', () => {
    const create = {
      version: 1,
      intent: 'apply',
      command: 'create_person',
      operationId,
      name: '  Anna   Jónsdóttir ',
      aliases: ['Anna', 'anna', 'Anna Jónsdóttir'],
    };
    const result = parseOwnerEditorRequest(create, people);
    expect(result.ok && result.request).toEqual({
      ...create,
      name: 'Anna Jónsdóttir',
      aliases: ['Anna'],
    });
    expect(parseOwnerEditorRequest({ ...create, relationship: 'known' }, people).ok).toBe(false);
    expect(parseOwnerEditorRequest({ ...create, name: 'x'.repeat(121) }, people).ok).toBe(false);
  });

  it('binds all validated draft meaning while ignoring object insertion order', () => {
    const parsed = parseOwnerEditorRequest(add, family);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.request.intent !== 'apply') return;
    const a = parsed.request;
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as OwnerEditorApply;
    expect(ownerEditorRequestHash(a)).toBe(ownerEditorRequestHash(reordered));
    for (const changed of [
      { ...a, note: 'A different owner statement' },
      { ...a, timing: 'past' },
      { ...a, validity: { validFrom: null, validUntil: '2026-01-01' } },
    ]) {
      expect(ownerEditorRequestHash(changed as OwnerEditorApply)).not.toBe(
        ownerEditorRequestHash(a),
      );
    }
  });

  it('accepts proof-only reconciliation on the original route and rejects a replacement draft', () => {
    const reconcile = {
      version: 1,
      intent: 'reconcile',
      command: add.command,
      operationId,
      receiptBindingToken: 'server-issued-original-request-proof',
    };
    expect(parseOwnerEditorRequest(reconcile, family).ok).toBe(true);
    expect(parseOwnerEditorRequest({ ...reconcile, note: 'overwrite' }, family).ok).toBe(false);
    expect(parseOwnerEditorRequest({ ...reconcile, requestHash: revision }, family).ok).toBe(false);
    expect(parseOwnerEditorRequest(reconcile, people).ok).toBe(false);
  });
});
