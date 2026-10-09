import net from 'node:net';
import tls from 'node:tls';

if (process.env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS === '1') {
  for (const key of Object.keys(process.env)) {
    if (
      /^(?:OPENAI|OPENROUTER|ANTHROPIC|GOOGLE|GCP|GCLOUD|GEMINI|VERTEX|TWILIO|SENDGRID|RESEND|GITHUB|GH_|FIRECRAWL|TAVILY|SERP|AWS|AZURE).*(?:API_KEY|TOKEN|CREDENTIAL|KEYFILE|SECRET|ACCESS_KEY|APPLICATION_CREDENTIALS)$/i.test(
        key,
      ) ||
      /^(?:GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_KEYFILE_JSON|GCLOUD_AUTH_CREDENTIAL_FILE_OVERRIDE)$/i.test(
        key,
      )
    )
      process.env[key] = '';
  }
  const loopback = (host) => {
    const value = String(host ?? '')
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    return (
      value === 'localhost' || value === '::1' || (net.isIPv4(value) && value.startsWith('127.'))
    );
  };
  const deny = (host) => {
    if (!loopback(host))
      throw new Error(`External network access is disabled in test runs (${host}).`);
  };
  const guardLookup = (host, lookup) =>
    function guardedLookup(...args) {
      const callback = args.at(-1);
      if (typeof callback !== 'function') return lookup.apply(this, args);
      return lookup.call(this, ...args.slice(0, -1), (...result) => {
        const [error, addresses] = result;
        if (!error) {
          const rows = Array.isArray(addresses) ? addresses : [{ address: addresses }];
          if (!rows.length || rows.some((row) => !loopback(row?.address))) deny(host);
        }
        callback(...result);
      });
    };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw);
    deny(url.hostname);
    const response = await originalFetch(input, { ...init, redirect: 'manual' });
    const location = response.headers.get('location');
    if (location && [301, 302, 303, 307, 308].includes(response.status)) {
      const redirected = new URL(location, url);
      deny(redirected.hostname);
      if (redirected.hostname !== url.hostname)
        throw new Error(`External redirect is disabled in test runs (${redirected.hostname}).`);
    }
    return response;
  };

  const originalSocketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (options, ...rest) {
    if (typeof options === 'string') return originalSocketConnect.call(this, options, ...rest);
    if (typeof options === 'number' && typeof rest[0] === 'string') deny(rest[0]);
    if (Array.isArray(options) && typeof options[0] === 'number' && typeof options[1] === 'string')
      deny(options[1]);
    const normalized = Array.isArray(options) ? options : [options];
    for (const candidate of normalized) {
      if (candidate && typeof candidate === 'object' && !candidate.path) {
        const host = candidate.host ?? candidate.hostname ?? 'localhost';
        if (!loopback(host)) {
          if (typeof candidate.lookup === 'function') {
            candidate.lookup = guardLookup(host, candidate.lookup);
          } else {
            deny(host);
          }
        }
      }
    }
    return originalSocketConnect.call(this, options, ...rest);
  };

  const originalTlsConnect = tls.connect;
  tls.connect = function (options, ...rest) {
    if (options && typeof options === 'object')
      deny(options.host ?? options.hostname ?? options.servername ?? 'localhost');
    return originalTlsConnect.call(this, options, ...rest);
  };
}
