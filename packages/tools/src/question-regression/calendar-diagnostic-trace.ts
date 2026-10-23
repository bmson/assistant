import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ModelRouter } from '@assistant/core';

export type DiagnosticModelMethod = 'generate' | 'step' | 'object' | 'embed';

export interface DiagnosticCaptureTruncation {
  truncated: true;
  sha256: string;
  preview: string;
}

export type DiagnosticModelInput =
  | {
      system?: string;
      messages?: unknown[];
      prompt?: string;
      query?: string[];
    }
  | DiagnosticCaptureTruncation;

export interface DiagnosticModelTrace {
  method: DiagnosticModelMethod;
  role: string;
  elapsedMs: number;
  outcome: 'returned' | 'threw';
  input: DiagnosticModelInput;
  output: unknown;
  errorName?: string;
  truncated: boolean;
}

const MAX_CAPTURE_BYTES = 64 * 1024;
const TRUNCATION_MARKER_BYTES = 160;
const tracedMethods = new Set<DiagnosticModelMethod>(['generate', 'step', 'object', 'embed']);

function serialized(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? 'null' : result;
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function boundedCapture(value: unknown): { value: unknown; truncated: boolean } {
  const json = serialized(value);
  const byteLength = Buffer.byteLength(json, 'utf8');
  if (byteLength <= MAX_CAPTURE_BYTES) {
    try {
      return { value: JSON.parse(json) as unknown, truncated: false };
    } catch {
      return { value: null, truncated: false };
    }
  }
  return {
    value: {
      truncated: true,
      sha256: createHash('sha256').update(json).digest('hex'),
      preview: utf8Prefix(json, MAX_CAPTURE_BYTES - TRUNCATION_MARKER_BYTES),
    } satisfies DiagnosticCaptureTruncation,
    truncated: true,
  };
}

function modelInput(method: DiagnosticModelMethod, args: unknown[]): unknown {
  if (method === 'embed') return { query: Array.isArray(args[0]) ? args[0] : [] };

  const options = args[1];
  if (!options || typeof options !== 'object') return {};
  const row = options as Record<string, unknown>;
  const input: Record<string, unknown> = {};
  if (typeof row.system === 'string') input.system = row.system;
  if (typeof row.prompt === 'string') input.prompt = row.prompt;
  if (Array.isArray(row.messages)) {
    // Keep the model-visible message roles and contents. Deliberately omit
    // schema, tools, provider options, abort signals, and all other call data.
    input.messages = row.messages.map((message) => {
      if (!message || typeof message !== 'object') return message;
      const item = message as Record<string, unknown>;
      return {
        ...(typeof item.role === 'string' ? { role: item.role } : {}),
        ...(Object.hasOwn(item, 'content') ? { content: item.content } : {}),
      };
    });
  }
  return input;
}

function roleFor(method: DiagnosticModelMethod, args: unknown[]): string {
  return method === 'embed' ? 'embed' : typeof args[0] === 'string' ? args[0] : 'unknown';
}

/**
 * Observes actual model-router entry calls for synthetic diagnostics. The
 * wrapped router receives the original arguments and its results/errors pass
 * through unchanged; this proxy performs no routing, retries, or extra calls.
 */
export function traceDiagnosticRouter(
  router: ModelRouter,
  trace: DiagnosticModelTrace[],
): ModelRouter {
  return new Proxy(router, {
    get(target, property) {
      const method = typeof property === 'string' ? property : '';
      const original = Reflect.get(target, property, target) as unknown;
      if (typeof original !== 'function' || !tracedMethods.has(method as DiagnosticModelMethod))
        return original;

      const diagnosticMethod = method as DiagnosticModelMethod;
      return async (...args: unknown[]) => {
        let inputCapture: { value: unknown; truncated: boolean };
        try {
          inputCapture = boundedCapture(modelInput(diagnosticMethod, args));
        } catch {
          // An unusual getter or proxy in diagnostic input must not prevent
          // the underlying router method from seeing the original arguments.
          inputCapture = boundedCapture({});
        }
        const startedAt = performance.now();
        try {
          const output = await Reflect.apply(original, target, args);
          const elapsedMs = Math.max(0, performance.now() - startedAt);
          const outputCapture = boundedCapture(output);
          try {
            trace.push({
              method: diagnosticMethod,
              role: roleFor(diagnosticMethod, args),
              elapsedMs,
              outcome: 'returned',
              input: inputCapture.value as DiagnosticModelInput,
              output: outputCapture.value,
              truncated: inputCapture.truncated || outputCapture.truncated,
            });
          } catch {
            // Diagnostics must never alter a model call's observable result.
          }
          return output;
        } catch (error) {
          try {
            trace.push({
              method: diagnosticMethod,
              role: roleFor(diagnosticMethod, args),
              elapsedMs: Math.max(0, performance.now() - startedAt),
              outcome: 'threw',
              input: inputCapture.value as DiagnosticModelInput,
              output: null,
              ...(error instanceof Error ? { errorName: error.name } : {}),
              truncated: inputCapture.truncated,
            });
          } catch {
            // A failed diagnostic sink must not mask the original model error.
          }
          throw error;
        }
      };
    },
  });
}
