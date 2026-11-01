import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PersonControls } from './person-controls';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/app/profile/actions', () => ({
  deleteContactAction: vi.fn(() => {
    throw new Error('Render-only person controls must not delete a contact');
  }),
  updateContactIdentityAction: vi.fn(() => {
    throw new Error('Render-only person controls must not submit an identity edit');
  }),
}));

describe('legacy person identity form revision handling', () => {
  const base = {
    contactId: '22222222-2222-4222-8222-222222222222',
    initialName: 'Sam',
    initialAliases: ['Samuel'],
    initialRelationship: 'friend',
  };

  it('keeps the form visible but blocks saving when its displayed revision is missing', () => {
    const html = renderToStaticMarkup(<PersonControls {...base} />);
    expect(html).toContain('Name');
    expect(html).toContain('Samuel');
    expect(html).toContain('Reopen this person to review current details before editing.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
  });

  it('allows editing a versioned detail while keeping an unchanged save disabled', () => {
    const html = renderToStaticMarkup(
      <PersonControls {...base} identityRevision={'a'.repeat(64)} />,
    );
    expect(html).toContain('Save changes</button>');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    expect(html).not.toMatch(/<input[^>]*disabled=""/);
    expect(html).not.toContain('review current details before editing');
  });
});
