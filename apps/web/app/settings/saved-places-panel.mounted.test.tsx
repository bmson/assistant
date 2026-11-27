// @vitest-environment jsdom

import type {
  ActiveSavedPlace,
  SavedPlacesSnapshot,
  SavedPlaceWrite,
} from '@assistant/persistence';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SavedPlacesPanel } from './saved-places-panel';

const actions = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('./saved-places-action', () => ({ savePlace: actions.save }));

const ADDRESS_A = '3 Example Lane, Juniper Bay, Exampleland';
const ADDRESS_B = '4 Example Lane, Juniper Bay, Exampleland';
const ADDRESS_EDIT = '5 Example Lane, Juniper Bay, Exampleland';

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(
    new Event(input instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }),
  );
}

it('reviews the address before saving, reopens two matching names and removes only the selected address', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let places: ActiveSavedPlace[] = [];
  const snapshot = (): SavedPlacesSnapshot => ({ generation: null, places: [...places] });
  actions.save.mockImplementation(async (command: SavedPlaceWrite) => {
    places = places.filter(({ id }) => id !== command.id);
    if (command.details)
      places.push({ id: command.id, revision: command.revision, details: command.details });
    return { snapshot: snapshot() };
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  async function button(label: string) {
    const target = Array.from(container.querySelectorAll('button')).find(
      (element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label,
    );
    if (!target) throw new Error(`Missing button: ${label}`);
    await act(async () => target.click());
  }

  async function fill(label: string, value: string) {
    const control = Array.from(container.querySelectorAll('label'))
      .find((element) => element.textContent?.trim().startsWith(label))
      ?.querySelector('input, select');
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement))
      throw new Error(`Missing form field: ${label}`);
    await act(async () => setValue(control, value));
  }

  async function add(address: string) {
    await button('Add place');
    await fill('Category', 'venue');
    await fill('Place name', 'Community Hall');
    await fill('Full address', address);
    const calls = actions.save.mock.calls.length;
    await button('Review place');
    expect(actions.save).toHaveBeenCalledTimes(calls);
    expect(document.activeElement?.textContent).toContain('Confirm saved place');
    expect(container.textContent).toContain(address);
    await button('Save place');
    expect(container.querySelector('[role=status]')?.textContent).toBe('Place saved.');
  }

  try {
    await act(async () => root.render(<SavedPlacesPanel key="initial" initial={snapshot()} />));
    await add(ADDRESS_A);
    await add(ADDRESS_B);
    await act(async () => root.render(<SavedPlacesPanel key="reopened" initial={snapshot()} />));
    expect(container.textContent).toContain(ADDRESS_A);
    expect(container.textContent).toContain(ADDRESS_B);
    const original = places.find(({ details }) => details.address === ADDRESS_A);
    await button(`Edit Community Hall, ${ADDRESS_A}`);
    await fill('Full address', ADDRESS_EDIT);
    await button('Review place');
    await button('Back to edit');
    await button('Cancel');
    expect(actions.save).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(ADDRESS_A);
    expect(container.textContent).not.toContain(ADDRESS_EDIT);
    await button(`Edit Community Hall, ${ADDRESS_A}`);
    await fill('Full address', ADDRESS_EDIT);
    await button('Review place');
    await button('Save place');
    expect(actions.save.mock.lastCall?.[0]).toMatchObject({
      id: original?.id,
      expectedRevision: original?.revision,
    });
    await button(`Remove Community Hall, ${ADDRESS_EDIT}`);
    expect(document.activeElement?.textContent).toContain('Remove this place?');
    expect(container.textContent).toContain(ADDRESS_EDIT);
    await button('Remove place');
    expect(container.querySelector('[role=status]')?.textContent).toBe('Place removed.');
    expect(container.textContent).not.toContain(ADDRESS_EDIT);
    expect(container.textContent).toContain(ADDRESS_B);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    actions.save.mockReset();
  }
});
