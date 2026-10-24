import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRecallOperationFence,
  type RecallSource,
  readRecallSourceSetting,
  writeRecallSourceSetting,
} from './message-view';
import {
  ReplyContextDetails,
  ReplyContextFooter,
  replyContextDate,
  replyContextKind,
  replyContextRecords,
} from './reply-context-footer';

const source: RecallSource = {
  label: 'Private <script>source</script>\nfull label',
  date: '2026-09-12',
  kind: 'chat',
  surfaceKey: 'a'.repeat(64),
  sourceRevision: 'b'.repeat(64),
};
const now = new Date('2026-10-23T01:00:00Z');
afterEach(() => vi.unstubAllGlobals());

describe('reply context presentation', () => {
  it('deduplicates only equal surface and revision, preserving order and legacy entries', () => {
    const revision = { ...source, sourceRevision: 'c'.repeat(64) };
    const another = { ...source, surfaceKey: 'd'.repeat(64) };
    const legacy = { label: source.label, date: source.date };
    expect(
      replyContextRecords([
        source,
        { ...source, label: 'Same version' },
        revision,
        another,
        legacy,
        legacy,
      ]),
    ).toEqual([source, revision, another, legacy, legacy]);
  });
  it('exposes no private labels, metadata, controls, or titles in collapsed markup', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const html = renderToStaticMarkup(
      <ReplyContextFooter
        sources={[source, source]}
        messageId="durable"
        now={now}
        onFeedback={vi.fn()}
      />,
    );
    expect(html).toContain('Context for this reply');
    expect(html).toContain('1 item');
    expect(html).toContain('aria-expanded="false"');
    for (const privateText of [
      'Private',
      '2026-09-12',
      'Earlier chats',
      'Helpful',
      'recall-source-control',
      'title=',
    ]) {
      expect(html).not.toContain(privateText);
    }
    expect(fetch).not.toHaveBeenCalled(); // SSR only; effects are not executed by this check.
  });
  it('renders nothing for no sources', () => {
    expect(
      renderToStaticMarkup(<ReplyContextFooter sources={[]} messageId="durable" now={now} />),
    ).toBe('');
  });
  it('expanded details retain full plain text and honest legacy/unknown metadata', () => {
    const html = renderToStaticMarkup(
      <ReplyContextDetails
        id="details"
        sources={[
          { ...source, surfaceKey: undefined, sourceRevision: undefined },
          { label: 'Unknown entry', date: 'bad date' },
        ]}
        messageId="durable"
        now={now}
      />,
    );
    expect(html).toContain('Private &lt;script&gt;source&lt;/script&gt;\nfull label');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Sep 12');
    expect(html).toContain('Earlier chats');
    expect(html).toContain('Saved context');
    expect(html).toContain('Date unavailable');
    expect(html.match(/Privacy controls unavailable/g)).toHaveLength(2);
    expect(html).not.toContain('Helpful');
  });
  it('uses UTC dates, validates calendar dates, and does not infer source kinds', () => {
    expect(replyContextDate('2026-10-23', new Date('2026-10-23T23:59:59-10:00'))).toBe('Oct 23');
    expect(replyContextDate('2025-12-31', now)).toContain('2025');
    expect(replyContextDate('2026-02-30', now)).toBe('Date unavailable');
    expect(replyContextDate('2026-02-01T00:00:00Z', now)).toBe('Date unavailable');
    expect(replyContextKind(undefined)).toBe('Saved context');
  });
});

describe('existing recall transport and publication fencing', () => {
  it('keeps the authenticated source/revision GET and exact PATCH body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ suppressed: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, version: 1 }));
    vi.stubGlobal('fetch', fetch);
    expect(await readRecallSourceSetting(source)).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(
      `/api/recall/sources/${source.surfaceKey}?sourceRevision=${source.sourceRevision}`,
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(await writeRecallSourceSetting(source, false)).toBe('saved');
    expect(fetch.mock.calls[1][0]).toBe(`/api/recall/sources/${source.surfaceKey}`);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      suppressed: false,
      expectedSourceRevision: source.sourceRevision,
    });
  });
  it('does not interpret unreadable/failed GET or unconfirmed PATCH as success; preserves stale409 distinctly', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ suppressed: 'false' }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(Response.json({ ok: false }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('', { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    await expect(readRecallSourceSetting(source)).rejects.toThrow();
    await expect(readRecallSourceSetting(source)).rejects.toThrow();
    await expect(readRecallSourceSetting(source)).rejects.toThrow();
    await expect(writeRecallSourceSetting(source, true)).rejects.toThrow();
    await expect(writeRecallSourceSetting(source, true)).rejects.toThrow();
    expect(await writeRecallSourceSetting(source, true)).toBe('stale');
  });
  it('accepts only the active current operation, never reviving a retired ticket after remount', () => {
    const fence = createRecallOperationFence('same');
    fence.activate();
    const ticket = fence.begin();
    expect(fence.current(ticket)).toBe(true);
    fence.deactivate();
    fence.activate();
    expect(fence.current(ticket)).toBe(false);
    expect(fence.current(fence.begin())).toBe(true);
  });
});
