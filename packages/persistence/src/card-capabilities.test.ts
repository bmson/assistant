import { describe, expect, it } from 'vitest';
import { generatedBlockCapability, generatedSpecBlockCapability } from './card-capabilities.js';

describe('generated card capability registry', () => {
  it('does not treat inherited JavaScript object keys as registered blocks', () => {
    const facts = new Map([['f', { id: 'f', value: 'A value' }]]);
    for (const type of ['constructor', 'toString', '__proto__']) {
      expect(generatedBlockCapability({ type }, facts, 'native')).toEqual({
        shell: false,
        full: false,
      });
    }
  });
});

describe('web card form capability', () => {
  const form = {
    type: 'form',
    id: 'meeting',
    title: 'Meeting details',
    serverAction: 'submit_owner_chat_turn',
    submitLabel: 'Continue',
    warningFactIds: ['warning'],
    fields: [{ id: 'date', type: 'date', label: 'Date', required: true, sensitive: false }],
  };
  const facts = new Map([['warning', { id: 'warning', value: 'Check the time' }]]);
  it('renders the warning shell but calls it fully supported only when the owner review path exists', () => {
    expect(generatedBlockCapability(form, facts, 'web')).toEqual({ shell: true, full: false });
    expect(
      generatedBlockCapability(form, facts, 'web', 0, { formRendererAvailable: true }),
    ).toEqual({ shell: true, full: true });
    expect(generatedBlockCapability(form, facts, 'native')).toEqual({ shell: false, full: false });
  });
  it.each([
    ['sensitive', { ...form, fields: [{ ...form.fields[0], sensitive: true }] }],
    ['missing warning', { ...form, warningFactIds: ['missing'] }],
    ['unknown action', { ...form, serverAction: 'run_tool' }],
  ])('rejects a %s form as unsupported', (_name, candidate) => {
    expect(generatedBlockCapability(candidate, facts, 'web')).toEqual({
      shell: false,
      full: false,
    });
  });
});

describe('native card form capability negotiation', () => {
  const fact = { id: 'warning', value: 'Check the details' };
  const formBlock = (id: string) => ({
    type: 'form',
    id,
    title: 'Review details',
    serverAction: 'submit_owner_chat_turn',
    submitLabel: 'Review in message',
    warningFactIds: ['warning'],
    fields: [{ id: 'name', type: 'text', label: 'Name', required: true, sensitive: false }],
  });
  const spec = (blocks: unknown[]) => ({
    version: 1,
    title: 'Details',
    facts: [{ id: 'warning', value: fact.value }],
    blocks,
  });

  it('requires the complete renderer and accepts exactly one safe public form', () => {
    const one = spec([formBlock('request')]);
    expect(generatedSpecBlockCapability(one, 'native')).toEqual({ shell: false, full: false });
    expect(generatedSpecBlockCapability(one, 'native', { formRendererAvailable: true })).toEqual({
      shell: true,
      full: true,
    });
    expect(generatedSpecBlockCapability(one, 'web', { formRendererAvailable: true })).toEqual({
      shell: true,
      full: true,
    });
  });

  it('keeps multiple forms unsupported even after native negotiation', () => {
    const multiple = spec([formBlock('first'), formBlock('second')]);
    expect(
      generatedSpecBlockCapability(multiple, 'native', { formRendererAvailable: true }),
    ).toEqual({
      shell: false,
      full: false,
    });
  });

  it('does not negotiate sensitive values or unresolved warning/default facts', () => {
    const sensitive = spec([
      {
        ...formBlock('request'),
        fields: [{ id: 'name', type: 'text', label: 'Name', required: true, sensitive: true }],
      },
    ]);
    const unresolved = spec([
      {
        ...formBlock('request'),
        warningFactIds: ['missing'],
      },
    ]);
    for (const candidate of [sensitive, unresolved]) {
      expect(
        generatedSpecBlockCapability(candidate, 'native', { formRendererAvailable: true }),
      ).toEqual({
        shell: false,
        full: false,
      });
    }
  });
});
