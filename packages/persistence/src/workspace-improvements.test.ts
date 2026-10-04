import { describe, expect, it } from 'vitest';
import type { Records } from './records.js';
import { improvementModelChange, validateImprovementModels } from './workspace-improvements.js';

function model(id: string, patch: Partial<Records['models']> = {}): Records['models'] {
  return {
    id,
    enabled: true,
    promptCostPerMTok: '0',
    completionCostPerMTok: '0.1',
    capabilities: {},
    ...patch,
  } as Records['models'];
}

describe('evidence-backed routing proposal validation', () => {
  it.each([
    [{ role: 'draft', primaryModel: 'new' }, []],
    [{ role: 'draft', primaryModel: 'new' }, ['  ']],
    [{ role: 'unknown', primaryModel: 'new' }, ['task']],
    [{ role: 'draft' }, ['task']],
    [{ role: 'draft', primaryModel: 'new', fallbackModel: { id: 'invalid' } }, ['task']],
    [{ role: 'draft', primaryModel: 'new', fallbackModel: '  ' }, ['task']],
  ])('rejects incomplete proposals before promotion (%j)', (change, evidence) => {
    expect(() => improvementModelChange(change, evidence)).toThrow();
  });

  it('allows explicit single-field changes without inventing a fallback', () => {
    expect(
      improvementModelChange({ role: 'draft', primaryModel: 'new', fallbackModel: '' }, ['task']),
    ).toEqual({ role: 'draft', primaryModel: 'new' });
  });

  it.each([
    { enabled: false },
    { promptCostPerMTok: null },
    { completionCostPerMTok: null },
    { promptCostPerMTok: '-1' },
    { completionCostPerMTok: 'NaN' },
    { promptCostPerMTok: '' },
    { completionCostPerMTok: '  ' },
  ])('rejects the whole change when one requested model is not routable (%j)', (patch) => {
    expect(() =>
      validateImprovementModels(
        { role: 'draft', primaryModel: 'valid', fallbackModel: 'invalid' },
        [model('valid'), model('invalid', patch)],
      ),
    ).toThrow('not enabled with prices');
  });

  it('rejects absent models and embedding/chat role substitutions', () => {
    expect(() =>
      validateImprovementModels({ role: 'draft', primaryModel: 'missing' }, []),
    ).toThrow();
    expect(() =>
      validateImprovementModels({ role: 'draft', primaryModel: 'embed' }, [
        model('embed', { capabilities: { embedding: true } }),
      ]),
    ).toThrow('cannot serve');
    expect(() =>
      validateImprovementModels({ role: 'embed', primaryModel: 'chat' }, [model('chat')]),
    ).toThrow('cannot serve');
    expect(() =>
      validateImprovementModels({ role: 'embed', primaryModel: 'embed' }, [
        model('embed', { capabilities: { embedding: true } }),
      ]),
    ).not.toThrow();
  });
});
