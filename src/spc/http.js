// -----------------------------------------------------------------------------
// The HTTP transport: one request to the gateway on node:http, its own TCP
// connection each time (no keep-alive, no shared agent: an arm never waits
// behind a read), no redirect followed, a deadline for the whole exchange and
// a size cap on the body. Resolves { status, headers, body } for any status;
// rejects a GatewayError for the transport failures.
//
// `sendWithin`: the connection must be up within this many ms, else nothing
// is written and the error says `notSent` (a command never leaves late).
// `onSent` is called once the connection is up, right before the request is
// written: from then on the gateway may have received it.
//
// The returned promise carries `handle`: `abort()` cuts the exchange,
// `idleFor(now)` tells how long no byte came (an arm cuts a frozen read).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { CODES, GatewayError } from './errors.js';

const RESET_CODES = new Set(['ECONNRESET', 'EPIPE']);

function transportError(err, notSent) {
  const code = String(err?.code ?? '');
  if (RESET_CODES.has(code) || /socket hang up/i.test(String(err?.message ?? ''))) {
    return new GatewayError(CODES.RESET, `Connection closed (${code || 'hang up'})`, { notSent });
  }
  if (code.startsWith('HPE_')) {
    return new GatewayError(CODES.BAD_ANSWER, `Not HTTP (${code})`, { notSent });
  }
  // Only the error code: a message may carry an address.
  return new GatewayError(CODES.UNREACHABLE, code || 'Connection failed', { notSent });
}

/**
 * @param {object} options
 * @param {string} options.method GET or PUT
 * @param {string} options.origin `http://host:port`
 * @param {string} options.path `/spc/area`
 * @param {Record<string, string>} [options.headers]
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.onSent]
 */
export function httpRequest({
  method,
  origin,
  path,
  headers = {},
  timeout,
  sendWithin,
  maxBytes,
  onSent,
}) {
  let settled = false;
  let req = null;
  let connected = false;
  let lastByte = performance.now();
  let finish;
  const handle = {
    abort: () => finish?.(new GatewayError(CODES.CUT, 'Request cut', { notSent: !connected })),
    idleFor: () => performance.now() - lastByte,
    get connected() {
      return connected;
    },
  };
  const promise = new Promise((resolve, reject) => {
    const target = new URL(path, origin);
    let timer;
    let sendTimer;
    finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    timer = setTimeout(
      () =>
        finish(
          new GatewayError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`, {
            notSent: !connected,
          }),
        ),
      timeout,
    );
    if (sendWithin !== undefined) {
      sendTimer = setTimeout(
        () => {
          if (!connected) {
            finish(new GatewayError(CODES.NOT_SENT, 'Not connected in time', { notSent: true }));
          }
        },
        Math.max(0, sendWithin),
      );
    }
    const markSent = () => {
      if (connected || settled) return;
      connected = true;
      lastByte = performance.now();
      clearTimeout(sendTimer);
      onSent?.();
    };
    try {
      req = http.request(
        {
          method,
          host: target.hostname.replace(/^\[(.*)\]$/, '$1'),
          port: Number(target.port) || 80,
          path: `${target.pathname}${target.search}`,
          agent: false,
          headers: {
            accept: 'application/json',
            host: target.host,
            connection: 'close',
            ...(method === 'PUT' ? { 'content-length': 0 } : {}),
            ...headers,
          },
        },
        (res) => {
          markSent();
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            lastByte = performance.now();
            size += chunk.length;
            if (size > maxBytes) {
              finish(new GatewayError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', (err) => finish(transportError(err, false)));
        },
      );
      req.on('socket', (socket) => {
        if (!socket.connecting) markSent();
        else socket.once('connect', markSent);
      });
      req.on('error', (err) => finish(transportError(err, !connected)));
      req.end();
    } catch (err) {
      // http.request throws on a header it refuses: a failure, never a crash.
      finish(transportError(err, !connected));
    }
  });
  promise.handle = handle;
  return promise;
}
