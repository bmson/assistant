import assert from 'node:assert/strict';
import { test } from 'node:test';
import { googleCalendarReleaseCallback } from './google-calendar-release-config.mjs';

test('optional callback is absent by default and accepts only the exact HTTPS route', () => {
  assert.equal(googleCalendarReleaseCallback(undefined), undefined);
  assert.equal(googleCalendarReleaseCallback(''), undefined);
  const url = 'https://bot.bmson.com/api/oauth/google-calendar/callback';
  assert.equal(googleCalendarReleaseCallback(url), url);
  for (const value of [
    null,
    false,
    'https://bot.bmson.com',
    'http://bot.bmson.com/api/oauth/google-calendar/callback',
    `${url}?other=x`,
    `${url}#fragment`,
    `${url}/`,
    `${url},PRIVATE=replace`,
    `${url}\n`,
    'https://user@bot.bmson.com/api/oauth/google-calendar/callback',
    'https://bot.bmson.com:443/api/oauth/google-calendar/callback',
    'https://bot.bmson.com:8443/api/oauth/google-calendar/callback',
    'https://bot.bmson.com/api/oauth/other/../google-calendar/callback',
  ]) {
    assert.throws(() => googleCalendarReleaseCallback(value), /exact HTTPS/);
  }
});
