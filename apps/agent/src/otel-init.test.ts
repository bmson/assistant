import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { withSpan } from '../../../packages/core/src/otel.js';
import { createOtelProvider } from './otel-init.js';

afterAll(() => {
  context.disable();
  propagation.disable();
  trace.disable();
});

describe('agent OpenTelemetry bootstrap', () => {
  it('does not create an exporter or export spans when tracing is disabled', async () => {
    const exporter = new InMemorySpanExporter();
    const createExporter = vi.fn(() => exporter);

    expect(
      createOtelProvider(
        { OTEL_EXPORTER: 'none', OTEL_SERVICE_NAME: 'assistant-test' },
        createExporter,
      ),
    ).toBeUndefined();
    expect(createExporter).not.toHaveBeenCalled();

    await withSpan('disabled.operation', {}, async () => undefined);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('keeps concurrent async traces isolated and preserves error and shutdown behavior', async () => {
    const exporter = new InMemorySpanExporter();
    const shutdown = vi.spyOn(exporter, 'shutdown');
    const provider = createOtelProvider(
      { OTEL_EXPORTER: 'otlp', OTEL_SERVICE_NAME: 'assistant-test' },
      () => exporter,
    );
    if (!provider) throw new Error('trace provider was not created');

    const operations = [
      { operation: 'alpha', delay: 8 },
      { operation: 'beta', delay: 1 },
    ];
    const parentIds = new Map<string, string>();

    try {
      await Promise.all(
        operations.map(({ operation, delay }) =>
          withSpan('concurrent.parent', { operation }, async () => {
            const parent = trace.getSpan(context.active());
            if (!parent) throw new Error('parent span was not active');
            parentIds.set(operation, parent.spanContext().spanId);
            await new Promise((resolve) => setTimeout(resolve, delay));
            await withSpan('concurrent.child', { operation }, async () => undefined);
          }),
        ),
      );

      await expect(
        withSpan('synthetic.failure', {}, async () => {
          throw new Error('synthetic failure');
        }),
      ).rejects.toThrow('synthetic failure');
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const rootTraceIds: string[] = [];
      for (const { operation } of operations) {
        const parent = spans.find(
          (span) => span.name === 'concurrent.parent' && span.attributes.operation === operation,
        );
        const child = spans.find(
          (span) => span.name === 'concurrent.child' && span.attributes.operation === operation,
        );
        if (!parent || !child)
          throw new Error(
            `missing exported spans for ${operation}; saw ${spans
              .map((span) => `${span.name}:${String(span.attributes.operation ?? '')}`)
              .join(',')}`,
          );
        rootTraceIds.push(parent.spanContext().traceId);
        expect(parent.resource.attributes['service.name']).toBe('assistant-test');
        expect(child.parentSpanContext?.spanId).toBe(parentIds.get(operation));
        expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
      }
      expect(new Set(rootTraceIds).size).toBe(operations.length);

      const failure = spans.find((span) => span.name === 'synthetic.failure');
      expect(failure?.status.code).toBe(SpanStatusCode.ERROR);
      expect(failure?.events.some((event) => event.name === 'exception')).toBe(true);
    } finally {
      await provider.shutdown();
    }

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
