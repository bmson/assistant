import type { OwnerEditorApply } from '@assistant/persistence/owner-editor';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Browser/server protocol bytes for an already validated apply body. No headers or proof input. */
export function ownerEditorCanonicalApply(request: OwnerEditorApply): string {
  return `owner-editor-apply-v1\n${stableJson(request)}`;
}
