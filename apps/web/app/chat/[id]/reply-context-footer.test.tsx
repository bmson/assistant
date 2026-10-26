import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRecallOperationFence,
  decodeRecallSourceSetting,
  type RecallSource,
  type RecallSourceSettingPhase,
  RecallSourceSettingView,
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
    expect(html).toContain('Saved context:');
    expect(html).toContain('whitespace-pre-wrap break-words');
    expect(html).toContain('It does not delete the saved source or change this reply.');
    expect(html.match(/Privacy controls unavailable/g)).toHaveLength(2);
    expect(html.match(/Hiding an entry applies to this saved version only\./g)).toHaveLength(1);
    expect(html.indexOf('Hiding an entry applies to this saved version only.')).toBeLessThan(
      html.indexOf('<ul class="reply-context-records">'),
    );
    expect(html).not.toContain('Helpful');
  });
  it('shows one scope helper and one reply rating across known and unavailable entries', () => {
    const html = renderToStaticMarkup(
      <ReplyContextDetails
        id="details"
        sources={[source, { label: 'Legacy reference', date: 'bad date' }]}
        messageId="durable"
        conversationId="conversation"
        sessionScope="owner-session"
        now={now}
        onFeedback={vi.fn()}
      />,
    );
    expect(html).toContain('Check source setting');
    expect(html).toContain('Privacy controls unavailable for this saved reference.');
    expect(html.match(/Hiding an entry applies to this saved version only\./g)).toHaveLength(1);
    expect(html.match(/Was the context for this reply useful overall\?/g)).toHaveLength(1);
    expect(html.match(/One rating covers the context listed for this reply\./g)).toHaveLength(1);
    expect(html.match(/>Helpful</g)).toHaveLength(1);
    expect(html.match(/>Not useful</g)).toHaveLength(1);
  });
  it('uses UTC dates, validates calendar dates, and does not infer source kinds', () => {
    expect(replyContextDate('2026-10-23', new Date('2026-10-23T23:59:59-10:00'))).toBe('Oct 23');
    expect(replyContextDate('2025-12-31', now)).toContain('2025');
    expect(replyContextDate('2026-02-30', now)).toBe('Date unavailable');
    expect(replyContextDate('2026-02-01T00:00:00Z', now)).toBe('Date unavailable');
    expect(replyContextKind(undefined)).toBe('Saved context');
  });
});

describe('versioned future recall setting contract', () => {
  const valid = [
    { version: 1, status: 'allowed', suppressed: false },
    { version: 1, status: 'suppressed', suppressed: true },
    { version: 1, status: 'stale', suppressed: null },
    { version: 1, status: 'unavailable', suppressed: null },
  ];

  it.each(valid)('accepts only the exact verified wire pair $status', (value) => {
    expect(decodeRecallSourceSetting(value)).toEqual(value);
    // The previous client accepts boolean states only; unknown historical states fail read-only.
    expect(typeof value.suppressed === 'boolean').toBe(
      value.status === 'allowed' || value.status === 'suppressed',
    );
  });

  it('rejects legacy, rollout, contradictory and extended success bodies', () => {
    const malformed: unknown[] = [
      null,
      [],
      true,
      'allowed',
      { suppressed: false },
      { suppressed: true },
      { version: 1, status: 'allowed' },
      { version: 1, suppressed: false },
      { status: 'allowed', suppressed: false },
      { version: 2, status: 'allowed', suppressed: false },
      { version: '1', status: 'allowed', suppressed: false },
      { version: 1, status: 'unknown', suppressed: null },
      { version: 1, status: 'allowed', suppressed: 'false' },
      { version: 1, status: 'unavailable', suppressed: 'null' },
      { version: 1, status: 'allowed', suppressed: undefined },
      { version: 1, status: 'unavailable', suppressed: null, reason: 'missing_record' },
      { version: 1, status: 'allowed', suppressed: false, sourceRevision: 'c'.repeat(64) },
    ];
    for (const status of ['allowed', 'suppressed', 'stale', 'unavailable']) {
      for (const suppressed of [true, false, null]) {
        if (!valid.some((value) => value.status === status && value.suppressed === suppressed))
          malformed.push({ version: 1, status, suppressed });
      }
    }
    for (const value of malformed) expect(() => decodeRecallSourceSetting(value)).toThrow();
  });

  it('keeps domain stale/unavailable distinct from failed transport, without issuing PATCH', async () => {
    const signal = new AbortController().signal;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const value of valid) {
      fetch.mockResolvedValueOnce(Response.json(value));
      expect(await readRecallSourceSetting(source, signal)).toEqual(value);
    }
    fetch.mockResolvedValueOnce(Response.json({ suppressed: false }));
    await expect(readRecallSourceSetting(source, signal)).rejects.toThrow();
    fetch.mockResolvedValueOnce(new Response('<html>unreadable</html>', { status: 200 }));
    await expect(readRecallSourceSetting(source, signal)).rejects.toThrow();
    for (const [, options] of fetch.mock.calls) {
      expect(options).toEqual({ cache: 'no-store', signal });
      expect(options).not.toHaveProperty('method');
    }
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});

/** These render the production view; SSR does not execute mounted effects or click handlers. */
describe('future recall setting presentation', () => {
  function markup(
    status: RecallSourceSettingPhase,
    error: 'read' | 'write' | null = null,
    pending = false,
  ) {
    return renderToStaticMarkup(
      <RecallSourceSettingView
        status={status}
        pending={pending}
        error={error}
        onRead={vi.fn()}
        onSave={vi.fn()}
      />,
    );
  }

  it.each(['stale', 'unavailable'] as const)(
    'renders %s read-only, never as allowed/off',
    (status) => {
      const html = markup(status);
      expect(html).toContain('role="status"');
      expect(html).not.toContain('<button');
      expect(html).not.toContain('not hidden');
      expect(html).not.toContain('Allow this version');
      expect(html).not.toContain('Hide this version');
    },
  );

  it('offers explicit read retry or uncertain-write recheck while the setting remains unknown', () => {
    const failed = markup('unknown', 'read');
    expect(failed).toContain('Future recall setting unavailable');
    expect(failed).toContain('Retry checking setting');
    const uncertain = markup('unknown', 'write');
    expect(uncertain).toContain('Could not confirm result');
    expect(uncertain).toContain('Recheck source setting');
    for (const html of [failed, uncertain, markup('checking', null, true)]) {
      expect(html).not.toContain('Allow this version');
      expect(html).not.toContain('Hide this version');
      expect(html).not.toContain('This version is hidden by this control.');
      expect(html).not.toContain('This version is not hidden by this control.');
    }
    expect(markup('checking', null, true)).toContain('disabled=""');
  });

  it('describes verified states only for this control and saved version', () => {
    const allowed = markup('allowed');
    expect(allowed).toContain('Future recall: This version is not hidden by this control.');
    expect(allowed).toContain('Hide this version from future recall');
    const suppressed = markup('suppressed');
    expect(suppressed).toContain(
      'Future recall: This version is hidden by this control. The saved source is not deleted.',
    );
    expect(suppressed).toContain('The saved source is not deleted');
    expect(suppressed).toContain('Allow this version in future recall');
    for (const status of ['stale', 'unavailable', 'unknown', 'checking'] as const) {
      const html = markup(status);
      expect(html).not.toContain('This version is hidden by this control.');
      expect(html).not.toContain('This version is not hidden by this control.');
    }
    for (const status of ['allowed', 'suppressed'] as const) {
      const pending = markup(status, null, true);
      expect(pending).toContain('disabled=""');
      expect(pending).not.toContain('This version is hidden by this control.');
      expect(pending).not.toContain('This version is not hidden by this control.');
    }
  });
});

describe('existing recall transport and publication fencing', () => {
  it('keeps the authenticated source/revision GET and exact PATCH body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ version: 1, status: 'suppressed', suppressed: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, version: 1 }));
    vi.stubGlobal('fetch', fetch);
    expect(await readRecallSourceSetting(source)).toEqual({
      version: 1,
      status: 'suppressed',
      suppressed: true,
    });
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
