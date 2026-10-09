import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  cardsReplaceProse,
  ResponseCards,
  rendersAllCards,
  rendersSomeCards,
} from './response-card';
import { formatDistance, formatDuration } from './route-card';

const card = {
  kind: 'route',
  id: 'r1',
  mode: 'driving',
  origin: { label: 'Current Location', lat: 37.7857, lng: -122.4011, current: true },
  destination: {
    label: 'Oracle Park',
    address: '24 Willie Mays Plaza',
    lat: 37.7786,
    lng: -122.3893,
  },
  durationSeconds: 540,
  distanceMeters: 1850,
  departAt: '2026-09-22T18:00:00.000Z',
  arriveAt: '2026-09-22T18:09:00.000Z',
  routeName: 'King St',
  steps: [{ instruction: 'Turn right onto Howard St', distanceMeters: 900 }],
  polyline: '_p~iF~ps|U',
  mapsUrl: 'https://maps.apple.com/?saddr=37.7857%2C-122.4011&daddr=37.7786%2C-122.3893&dirflg=d',
  accompaniesProse: true,
};

describe('route card', () => {
  it('shows time, distance, leave and arrive in the owner zone, and the Apple Maps link', () => {
    expect(rendersAllCards([card])).toBe(true);
    expect(cardsReplaceProse([card])).toBe(false);
    const html = renderToStaticMarkup(
      <ResponseCards cards={[card]} timeZone="America/Los_Angeles" />,
    );
    expect(html).toContain('9 min');
    expect(html).toContain('1.1 mi · via King St');
    expect(html).toContain('leave 11:00 AM, arrive 11:09 AM');
    expect(html).toContain('/api/maps/snapshot?from=37.7857%2C-122.4011');
    expect(html).toContain('scheme=dark');
    expect(html).toContain('Open in Apple Maps');
  });

  it('formats distances by region and long trips in hours', () => {
    expect(formatDistance(1850, 'Atlantic/Reykjavik')).toBe('1.9 km');
    expect(formatDistance(120, 'America/New_York')).toBe('394 ft');
    expect(formatDuration(5400)).toBe('1 hr 30 min');
  });

  it('drops a link that does not go to Apple Maps', () => {
    const html = renderToStaticMarkup(
      <ResponseCards cards={[{ ...card, mapsUrl: 'https://evil.example/' }]} timeZone="UTC" />,
    );
    expect(html).not.toContain('evil.example');
  });

  it('keeps prose fallback and labels missing or invalid measurements as unavailable', () => {
    for (const value of [undefined, null, '540', -1]) {
      const invalid = { ...card, durationSeconds: value };
      expect(rendersAllCards([invalid])).toBe(false);
      expect(rendersSomeCards([invalid])).toBe(true);
      const html = renderToStaticMarkup(<ResponseCards cards={[invalid]} timeZone="UTC" />);
      expect(html).toContain('Duration unavailable');
    }
    const invalidDistance = { ...card, distanceMeters: -10 };
    expect(rendersAllCards([invalidDistance])).toBe(false);
    const html = renderToStaticMarkup(<ResponseCards cards={[invalidDistance]} timeZone="UTC" />);
    expect(html).toContain('Distance unavailable');
  });
});
