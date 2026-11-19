'use strict';

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { writeSync } = require('node:fs');

const PATCHED = Symbol.for('assistant.web17.previewHttp.patched');
const TOKEN_HEADER = 'x-web17-diagnostic-token';
const NONCE_HEADER = 'x-web17-attempt';
const CLASS_HEADER = 'x-web17-request-class';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EVENT_CAP = 48;

function isLoopback(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function tokenMatches(received, expected) {
  if (
    typeof received !== 'string' ||
    received.length !== 43 ||
    typeof expected !== 'string' ||
    !TOKEN_PATTERN.test(expected)
  )
    return false;
  const left = Buffer.from(received, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function installWeb17PreviewHttpObserver({ Server, token, writeRecord, env = process.env }) {
  if (!Server?.prototype || typeof writeRecord !== 'function' || typeof token !== 'string')
    return false;
  if (!TOKEN_PATTERN.test(token) || Server.prototype[PATCHED]) return false;
  const originalEmit = Server.prototype.emit;
  if (typeof originalEmit !== 'function') return false;
  let written = 0;
  const candidateNonces = new Set();

  const record = (nonce, phase, fields = {}) => {
    if (written >= EVENT_CAP) return false;
    written += 1;
    try {
      writeRecord({
        kind: 'WEB17_HTTP_TRANSPORT',
        nonce,
        phase,
        layer: 'node_local',
        duplicatePossible: true,
        ...fields,
      });
    } catch {
      // Diagnostics never change the original server event.
    }
    return true;
  };

  const eligibleRequest = (server, request) => {
    try {
      if (written >= EVENT_CAP) return null;
      if (
        request?.method !== 'GET' ||
        typeof request.url !== 'string' ||
        request.url.length > 4_096
      )
        return null;
      const question = request.url.indexOf('?');
      const pathname = question < 0 ? request.url : request.url.slice(0, question);
      if (pathname !== '/chat/all' || question < 0) return null;
      const query = request.url.slice(question + 1);
      if (!/(?:^|&)_rsc(?:=|&|$)/.test(query)) return null;
      const headers = request.headers;
      if (headers?.rsc !== '1' || headers[CLASS_HEADER] !== 'rsc') return null;
      if (!tokenMatches(headers[TOKEN_HEADER], token)) return null;
      const nonce = headers[NONCE_HEADER];
      if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return null;
      if (!candidateNonces.has(nonce) && candidateNonces.size >= 2) return null;
      const address = server.address();
      if (
        env.NODE_ENV !== 'development' ||
        env.WEB_APP_PREVIEW_ENABLED !== 'true' ||
        !address ||
        typeof address === 'string' ||
        address.port !== 3001 ||
        !isLoopback(address.address) ||
        !isLoopback(request.socket?.remoteAddress)
      )
        return null;
      if (!candidateNonces.has(nonce)) {
        if (candidateNonces.size >= 2) return null;
        candidateNonces.add(nonce);
      }
      return nonce;
    } catch {
      return null;
    }
  };

  const observedEmit = function web17ObservedEmit(...args) {
    if (args[0] === 'request') {
      try {
        const [request, response] = args.slice(1);
        const nonce = eligibleRequest(this, request);
        if (nonce && response && typeof response.once === 'function') {
          record(nonce, 'node_request_dispatch');
          if (written < EVENT_CAP) {
            response.once('finish', () => {
              try {
                const status = response.statusCode;
                record(nonce, 'node_response_finish', {
                  status:
                    Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
                });
              } catch {}
            });
            response.once('close', () => {
              try {
                record(nonce, 'node_response_close', {
                  writableFinished: response.writableFinished === true,
                });
              } catch {}
            });
          }
        }
      } catch {
        // Observer setup is isolated from Node's original emit behavior.
      }
    }
    return Reflect.apply(originalEmit, this, args);
  };
  try {
    Object.defineProperty(Server.prototype, PATCHED, { value: true });
    Object.defineProperty(Server.prototype, 'emit', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: observedEmit,
    });
  } catch {
    try {
      delete Server.prototype[PATCHED];
    } catch {}
    return false;
  }
  return true;
}

function writeStderr(record) {
  try {
    const line = `[WEB17_HTTP] ${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, 'utf8') <= 256) writeSync(2, line);
  } catch {
    // Logging failure must not affect the server.
  }
}

if (process.env.WEB17_DIAGNOSTICS === '1') {
  try {
    installWeb17PreviewHttpObserver({
      Server: http.Server,
      token: process.env.WEB17_HTTP_DIAGNOSTIC_TOKEN,
      writeRecord: writeStderr,
    });
  } catch {}
}

module.exports = { installWeb17PreviewHttpObserver };
