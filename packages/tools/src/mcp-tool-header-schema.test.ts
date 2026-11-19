import { describe, expect, it } from 'vitest';
import { validateMcpToolHeaderSchema as valid } from './mcp-tool-header-schema.js';

const leaf = (patch: Record<string, unknown> = {}) => ({
  type: 'string',
  'x-mcp-header': 'Region',
  ...patch,
});
const input = (property: unknown = leaf()) => ({
  type: 'object',
  properties: { region: property },
});

describe('discovery-only MCP tool header schema annotations', () => {
  it.each(['string', 'integer', 'boolean'])('accepts explicit primitive type %j', (type) => {
    expect(valid(input(leaf({ type })))).toBe(true);
  });

  it('accepts nested object properties and all RFC token punctuation without mutating schema', () => {
    const schema = input({
      type: 'object',
      properties: { nested: leaf({ 'x-mcp-header': "!#$%&'*+-.^_`|~AZaz09" }) },
    });
    const before = JSON.stringify(schema);
    expect(valid(schema)).toBe(true);
    expect(JSON.stringify(schema)).toBe(before);
    expect(valid(input())).toBe(true); // Names do not leak between tools.
  });

  it.each([
    '',
    'Bad Header',
    'Header:Name',
    'Header\r\nInjected',
    'Region\n',
    'Region\r',
    'Region\r\n',
    'Header\0',
    'café',
    '地域',
    1,
    null,
    {},
    ['Region'],
  ])('rejects an invalid field name %j', (header) => {
    expect(valid(input(leaf({ 'x-mcp-header': header })))).toBe(false);
  });

  it.each([
    'number',
    'object',
    'array',
    'null',
    undefined,
    [],
    ['string', 'number'],
    ['string', 'string'],
    ['null'],
    ['string', 'object'],
    ['string'],
    ['string', 'null'],
    ['null', 'integer'],
    ['boolean', 'string'],
    ['integer', 'string', 'null'],
  ])('rejects an unsupported or malformed annotated type %j', (type) => {
    const property: Record<string, unknown> = leaf({ type });
    if (type === undefined) delete property.type;
    expect(valid(input(property))).toBe(false);
  });

  it('rejects a missing explicit type even when a reference would provide it', () => {
    expect(valid(input({ $ref: '#/$defs/text', 'x-mcp-header': 'Region' }))).toBe(false);
  });

  it('rejects a root annotation and case-insensitive duplicates across property paths', () => {
    expect(valid(leaf())).toBe(false);
    expect(
      valid({
        properties: { a: leaf(), b: { properties: { c: leaf({ 'x-mcp-header': 'rEGION' }) } } },
      }),
    ).toBe(false);
    expect(valid({ properties: { a: leaf(), b: leaf({ 'x-mcp-header': 'Other' }) } })).toBe(true);
  });

  it.each(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'])(
    'rejects annotations below array/composition schema keyword %s',
    (keyword) => {
      expect(valid({ [keyword]: [input()] })).toBe(false);
    },
  );

  it.each([
    'not',
    'if',
    'then',
    'else',
    'items',
    'contains',
    'additionalItems',
    'additionalProperties',
    'unevaluatedProperties',
    'unevaluatedItems',
    'propertyNames',
    'contentSchema',
    'unknownWrapper',
  ])('rejects annotations below a non-properties edge %s', (keyword) => {
    expect(valid(input({ [keyword]: input() }))).toBe(false);
  });

  it.each(['$defs', 'definitions', 'patternProperties', 'dependentSchemas', 'dependencies'])(
    'rejects annotations in named schema maps %s, without treating map names as annotations',
    (keyword) => {
      expect(valid({ [keyword]: { item: input() } })).toBe(false);
      expect(valid({ [keyword]: { 'x-mcp-header': { type: 'string' } } })).toBe(true);
    },
  );

  it('does not confuse parameter names with schema annotation keywords', () => {
    expect(
      valid({
        properties: {
          'x-mcp-header': { type: 'string' },
          properties: { type: 'string' },
          default: leaf(),
        },
      }),
    ).toBe(true);
    expect(valid({ properties: { 'x-mcp-header': leaf() } })).toBe(true);
    expect(valid({ properties: { 'x-mcp-header': 'Region' } })).toBe(false);
    expect(valid({ properties: [{ region: leaf() }] })).toBe(false);
  });

  it('treats examples/default/enum/const as literal data, including schema-looking data', () => {
    const literal = { 'x-mcp-header': 'not a header', properties: { nested: leaf() } };
    expect(
      valid({ ...input(), default: literal, examples: [literal], enum: [literal], const: literal }),
    ).toBe(true);
    expect(valid(input({ type: 'object', default: literal, examples: [literal] }))).toBe(true);
    expect(
      valid({
        dependentRequired: { 'x-mcp-header': ['properties'] },
        dependencies: { 'x-mcp-header': ['other'] },
      }),
    ).toBe(true);
  });

  it('keeps unannotated compositions and references valid without resolving remote references', () => {
    expect(
      valid({
        allOf: [{ type: 'object' }],
        properties: {
          other: { $ref: 'https://example.invalid/schema' },
          region: leaf({ $ref: '#/$defs/text' }),
        },
        $defs: { text: { type: 'string' } },
      }),
    ).toBe(true);
  });

  it('does not constrain integer schema defaults/ranges as though they were call arguments', () => {
    expect(
      valid(input(leaf({ type: 'integer', default: Number.MAX_SAFE_INTEGER + 1, maximum: 1e20 }))),
    ).toBe(true);
  });

  it('bounds encoded UTF-8 bytes even inside ignored literal values', () => {
    expect(valid({ description: 'x'.repeat(299_982) })).toBe(true); // Exactly 300000 JSON bytes.
    expect(valid({ description: 'x'.repeat(299_983) })).toBe(false);
    expect(valid({ default: '界'.repeat(100_000) })).toBe(false);
  });

  it('bounds depth, breadth and cycles before semantic traversal, including literals', () => {
    let schema: Record<string, unknown> = input();
    for (let i = 0; i < 70; i++) schema = { properties: { nested: schema } };
    expect(valid(schema)).toBe(false);
    expect(valid({ default: Array(20_001).fill(null) })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.default = cyclic;
    expect(valid(cyclic)).toBe(false);
    expect(valid({ default: [Number.NaN] })).toBe(false);
  });
});
