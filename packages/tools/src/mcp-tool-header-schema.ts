// Discovery-only validation of SEP-2243, revision 2026-07-28:
// https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#schema-extension
// This neither resolves references nor extracts/transmits argument values.
const MAX_BYTES = 300_000;
const MAX_DEPTH = 64;
const MAX_NODES = 20_000;
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRIMITIVES = new Set(['string', 'integer', 'boolean']);
const LITERAL_KEYWORDS = new Set(['const', 'enum', 'default', 'examples', 'dependentRequired']);
const SCHEMA_MAPS = new Set(['$defs', 'definitions', 'patternProperties', 'dependentSchemas']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Bound the entire JSON tree, including literal data, without recursive serialization. */
function boundedJson(schema: Record<string, unknown>): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry || ++nodes > MAX_NODES || entry.depth > MAX_DEPTH) return false;
    const { value, depth } = entry;
    if (typeof value === 'string') {
      if (value.length > MAX_BYTES) return false;
      bytes += Buffer.byteLength(JSON.stringify(value));
    } else if (value === null || typeof value === 'boolean') {
      bytes += value === null ? 4 : value ? 4 : 5;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      bytes += String(value).length;
    } else if (Array.isArray(value)) {
      if (nodes + pending.length + value.length > MAX_NODES) return false;
      bytes += 2 + Math.max(0, value.length - 1);
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
    } else if (record(value)) {
      const keys = Object.keys(value);
      if (nodes + pending.length + keys.length > MAX_NODES) return false;
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        if (key.length > MAX_BYTES) return false;
        bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        pending.push({ value: value[key], depth: depth + 1 });
      }
    } else {
      return false;
    }
    if (bytes > MAX_BYTES) return false;
  }
  return true;
}

function primitiveType(type: unknown): boolean {
  return typeof type === 'string' && PRIMITIVES.has(type);
}

/**
 * Whether a single tool's schema has valid header annotations. This is not a
 * general JSON Schema validator. Supported primitive types must be explicit
 * scalar declarations, matching the official SDK. Null argument omission,
 * integer range and value encoding belong to execution, never discovery.
 * Local bounds exclude this tool rather than abandoning the other tools.
 */
export function validateMcpToolHeaderSchema(schema: Record<string, unknown>): boolean {
  if (!record(schema) || !boundedJson(schema)) return false;
  const names = new Set<string>();
  function scan(value: unknown, reachable: boolean, parameter: boolean): boolean {
    if (Array.isArray(value)) return value.every((item) => scan(item, false, false));
    if (!record(value)) return true;
    if (Object.hasOwn(value, 'x-mcp-header')) {
      const header = value['x-mcp-header'];
      if (
        !reachable ||
        !parameter ||
        !primitiveType(value.type) ||
        typeof header !== 'string' ||
        !FIELD_NAME.test(header) ||
        names.has(header.toLowerCase())
      )
        return false;
      names.add(header.toLowerCase());
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'x-mcp-header' || LITERAL_KEYWORDS.has(key)) continue;
      if (key === 'properties' || SCHEMA_MAPS.has(key) || key === 'dependencies') {
        if (!record(child)) return false;
        for (const propertySchema of Object.values(child)) {
          // Draft-07 dependencies can be literal property-name arrays.
          if (
            key === 'dependencies' &&
            Array.isArray(propertySchema) &&
            propertySchema.every((v) => typeof v === 'string')
          )
            continue;
          if (typeof propertySchema !== 'boolean' && !record(propertySchema)) return false;
          if (!scan(propertySchema, reachable && key === 'properties', key === 'properties'))
            return false;
        }
      } else if (!scan(child, false, false)) {
        return false;
      }
    }
    return true;
  }
  return scan(schema, true, false);
}
