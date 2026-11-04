import type { Config } from '@assistant/config';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
  TracerProvider,
} from '@opentelemetry/sdk-trace';

type OtelConfig = Pick<Config, 'OTEL_EXPORTER' | 'OTEL_SERVICE_NAME'>;
type ExporterMode = Exclude<Config['OTEL_EXPORTER'], 'none'>;
type ExporterFactory = (mode: ExporterMode) => SpanExporter;

function createExporter(mode: ExporterMode): SpanExporter {
  return mode === 'console' ? new ConsoleSpanExporter() : new OTLPTraceExporter();
}

/**
 * Register the configured trace SDK and its Node async context manager.
 * Exporting this small seam keeps the disabled and context behavior testable
 * without activating an external exporter.
 */
export function createOtelProvider(
  config: OtelConfig,
  exporterFactory: ExporterFactory = createExporter,
): TracerProvider | undefined {
  if (config.OTEL_EXPORTER === 'none') return undefined;

  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': config.OTEL_SERVICE_NAME }),
    spanProcessors: [new BatchSpanProcessor({ exporter: exporterFactory(config.OTEL_EXPORTER) })],
  });

  trace.setGlobalTracerProvider(provider);

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );

  return provider;
}

/** Initialize tracing only when an explicit exporter mode is configured. */
export function initOtel(config: OtelConfig): void {
  const provider = createOtelProvider(config);
  if (!provider) return;

  process.on('SIGTERM', () => void provider.shutdown());
}
