'use client';

import DOMPurify from 'dompurify';
import { useEffect, useId, useState } from 'react';

const MAX_SOURCE_CHARS = 20_000;

function withViewBoxDimensions(svgSource: string): string {
  const parsed = new DOMParser().parseFromString(svgSource, 'image/svg+xml');
  const svg = parsed.documentElement;
  const viewBox = svg
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = viewBox?.[2];
  const height = viewBox?.[3];
  if (
    svg.localName !== 'svg' ||
    viewBox?.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    !width ||
    !height ||
    width <= 0 ||
    height <= 0
  ) {
    return svgSource;
  }
  // These numeric values come only from the sanitized SVG's finite viewBox.
  svg.setAttribute('width', `${width}px`);
  svg.setAttribute('height', `${height}px`);
  return new XMLSerializer().serializeToString(svg);
}

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const [svgUrl, setSvgUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    setSvgUrl('');
    setError('');
    if (source.length > MAX_SOURCE_CHARS) {
      setError('This diagram is too large to render safely.');
      return () => {
        cancelled = true;
      };
    }
    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          // mermaid 12 defaults to a new layout and look; keep the palette below readable.
          layout: 'dagre',
          look: 'classic',
          theme: 'base',
          flowchart: { htmlLabels: false, useMaxWidth: true },
          themeVariables: {
            primaryColor: '#e8f2ec',
            primaryTextColor: '#17251d',
            primaryBorderColor: '#2d8a5a',
            lineColor: '#47745c',
            secondaryColor: '#f3f7f4',
            tertiaryColor: '#ffffff',
          },
        });
        const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        const rendered = await mermaid.render(id, source);
        if (cancelled) return;
        const safeSvg = DOMPurify.sanitize(rendered.svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
        // Preserve Mermaid's natural text size; the parent contains wide diagrams.
        const sizedSvg = withViewBoxDimensions(safeSvg);
        objectUrl = URL.createObjectURL(new Blob([sizedSvg], { type: 'image/svg+xml' }));
        setSvgUrl(objectUrl);
        setError('');
      })
      .catch(() => {
        if (!cancelled) setError('This Mermaid diagram could not be rendered.');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reactId, source]);

  return (
    <figure className="my-3 overflow-hidden rounded-xl border border-edge bg-raised first:mt-0 last:mb-0">
      <figcaption className="border-b border-edge/60 bg-sunken/40 px-4 py-2 text-xs leading-5 font-medium text-accent">
        Diagram
      </figcaption>
      {svgUrl ? (
        <section
          aria-label="Mermaid diagram, horizontally scrollable"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must be keyboard reachable.
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            event.currentTarget.scrollBy({ left: event.key === 'ArrowRight' ? 40 : -40 });
          }}
          className="overflow-x-auto p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {/* A sanitized in-memory SVG is not an optimizable network image. */}
          {/* biome-ignore lint/performance/noImgElement: blob URLs cannot use next/image. */}
          <img src={svgUrl} className="mx-auto h-auto max-w-none" alt="Rendered Mermaid diagram" />
        </section>
      ) : error ? (
        <p className="px-4 py-3 text-sm text-muted" role="status">
          {error}
        </p>
      ) : (
        <p className="px-4 py-3 text-sm text-muted" role="status">
          Rendering diagram…
        </p>
      )}
      <details className="border-t border-edge/60 px-4 py-2 text-xs text-muted">
        <summary className="cursor-pointer select-none font-medium text-strong">
          View diagram source
        </summary>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-3 font-mono text-[11px] leading-5">
          {source}
        </pre>
      </details>
    </figure>
  );
}
