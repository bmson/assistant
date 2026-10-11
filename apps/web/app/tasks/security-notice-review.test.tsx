import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecurityNoticeReview } from './security-notice-review';

describe('SecurityNoticeReview', () => {
  it('starts in an explicit loading state and exposes refresh', () => {
    const html = renderToStaticMarkup(<SecurityNoticeReview ownerId="fixture-owner" />);
    expect(html).toContain('Up to 50 notices that may need your review.');
    expect(html).toContain('Loading security reviews');
    expect(html).toContain('Refresh');
  });
});
