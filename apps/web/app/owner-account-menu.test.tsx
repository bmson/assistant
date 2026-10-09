import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OwnerAccountMenu } from './owner-account-menu';

describe('OwnerAccountMenu browser sign-out', () => {
  it('uses a native POST form so sign-out is independent of the current page action policy', () => {
    const markup = renderToStaticMarkup(<OwnerAccountMenu name="Synthetic owner" />);
    expect(markup).toMatch(
      /<form(?=[^>]*action="\/api\/owner\/browser-signout")(?=[^>]*method="post")[^>]*>/,
    );
    expect(markup).toContain('Sign out of this browser');
    expect(markup).toContain('type="submit"');
  });
});
