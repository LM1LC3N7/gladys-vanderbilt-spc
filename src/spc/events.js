// -----------------------------------------------------------------------------
// The websocket of the gateway (ws://host:port/ws/spc): SIA events pushed by
// the panel (pyspcwebgw websocket.py). One connection at a time, opened with
// a handshake timeout, messages bounded (maxPayload, no compression, binary
// frames ignored), no redirect followed. The connection never reopens by
// itself: the app decides when. The credentials, when the gateway asks for
// them, go in the Authorization header of the handshake (never in the URL).
// -----------------------------------------------------------------------------

import WebSocket from 'ws';
import { LIMITS, TIMINGS, WS_PATH } from '../constants.js';
import { authorization, parseChallenge } from './auth.js';
import { USER_AGENT } from './client.js';

/** A failure of the handshake: `kind` and the HTTP status, never a server text. */
const socketError = (kind, status) => Object.assign(new Error(kind), { kind, status });

/** The default socket factory: a `ws` client. */
export function defaultSocketFactory(url, options) {
  return new WebSocket(url, options);
}

export class EventSocket {
  /**
   * @param {object} options
   * @param {string} options.host `host:port`
   * @param {object} options.client the GatewayClient (credentials and challenge)
   * @param {Function} options.onMessage (text) => void
   * @param {Function} options.onClose () => void, once, after the open
   * @param {Function} [options.factory]
   */
  constructor({ host, client, onMessage, onClose, factory = defaultSocketFactory }) {
    this.url = `ws://${host}${WS_PATH}`;
    this.client = client;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.factory = factory;
    this.socket = undefined;
    this.isOpen = false;
    this.ended = false;
    this.waitingPong = false;
  }

  /**
   * Opens: resolves once open; rejects an Error { kind: 'auth_required' |
   * 'auth_unsupported' | 'auth_refused' | 'http' | 'network', status }. A 401 is answered once with the
   * credentials (a new handshake).
   */
  async open() {
    let fresh = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sentWith =
        this.client.credentials && this.client.challenge ? this.client.challenge : null;
      const headers = { 'user-agent': USER_AGENT };
      if (sentWith) {
        headers.authorization = authorization(
          sentWith,
          this.client.credentials,
          'GET',
          WS_PATH,
          this.client.random,
        );
      }
      const result = await this.handshake(headers);
      if (result.open) return;
      if (result.status !== 401)
        throw socketError(result.status ? 'http' : 'network', result.status);
      if (!this.client.credentials) throw socketError('auth_required', 401);
      const challenge = parseChallenge(result.headers?.['www-authenticate']);
      if (!challenge) throw socketError('auth_unsupported', 401);
      const refused =
        sentWith && (fresh || sentWith.scheme === 'basic') && !(challenge.stale && !fresh);
      if (refused || attempt === 1) throw socketError('auth_refused', 401);
      this.client.challenge = challenge;
      fresh = true;
    }
  }

  /** One handshake: { open: true } or { status, headers } (status undefined: network). */
  handshake(headers) {
    return new Promise((resolve) => {
      if (this.ended) {
        resolve({});
        return;
      }
      let settled = false;
      let refusal = {};
      let socket;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        socket = this.factory(this.url, {
          headers,
          handshakeTimeout: TIMINGS.wsHandshake,
          maxPayload: LIMITS.maxMessage,
          perMessageDeflate: false,
          followRedirects: false,
        });
      } catch {
        settle({});
        return;
      }
      this.socket = socket;
      socket.on('unexpected-response', (_request, response) => {
        refusal = { status: Number(response?.statusCode) || 0, headers: response?.headers ?? {} };
        try {
          response?.resume?.();
        } catch {
          // nothing to drain
        }
        socket.terminate();
      });
      socket.on('open', () => {
        if (this.ended || this.socket !== socket) {
          socket.terminate();
          settle({});
          return;
        }
        this.isOpen = true;
        settle({ open: true });
      });
      socket.on('message', (data, isBinary) => {
        if (this.socket !== socket || this.ended || isBinary) return;
        this.onMessage(String(data));
      });
      socket.on('pong', () => {
        this.waitingPong = false;
      });
      // An 'error' is always followed by a 'close': the close decides.
      socket.on('error', () => {});
      socket.on('close', () => {
        const wasOpen = this.isOpen && this.socket === socket;
        if (this.socket === socket) this.isOpen = false;
        if (!settled) {
          settle(refusal);
          return;
        }
        if (wasOpen && !this.ended) {
          this.ended = true;
          this.onClose();
        }
      });
    });
  }

  /** A ping; false when the previous one got no pong (the connection is dead). */
  ping() {
    if (!this.isOpen || this.waitingPong) return false;
    this.waitingPong = true;
    try {
      this.socket.ping();
    } catch {
      return false;
    }
    return true;
  }

  /** Closes without calling onClose. */
  close() {
    this.ended = true;
    this.isOpen = false;
    try {
      this.socket?.terminate();
    } catch {
      // already closed
    }
  }

  /** Cuts a dead or flooding connection: onClose is called. */
  kill() {
    const wasOpen = this.isOpen;
    this.close();
    if (wasOpen) this.onClose();
  }
}
