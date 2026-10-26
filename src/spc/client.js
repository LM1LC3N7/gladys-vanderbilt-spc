// -----------------------------------------------------------------------------
// The REST API of the SPC Web Gateway (Lundix), ported from pyspcwebgw:
//   GET /spc/panel             -> data.panel   (serial, type, variant, version)
//   GET /spc/area[/<id>]       -> data.area    (a list; a list of one by id)
//   GET /spc/zone[/<id>]       -> data.zone    (a list; an object by id)
//   PUT /spc/area/<id>/<cmd>   cmd: set | set_a | set_b | unset -> { status }
// Every request has its own connection (an arm never waits behind a read).
// A 401 is answered once with the configured credentials (see auth.js); a
// 401 on credentials built from a challenge just received is a refusal, a
// 401 on a reused Digest nonce is not (the nonce expired: answered again).
// -----------------------------------------------------------------------------

import { COMMAND_OF_MODE, LIMITS, TIMINGS } from '../constants.js';
import { authorization, parseChallenge } from './auth.js';
import { CODES, GatewayError } from './errors.js';
import { httpRequest } from './http.js';
import { dataOf, parseArea, parseList, parseOne, parsePanel, parseZone } from './parse.js';

/** Our own identity, never that of an app. */
export const USER_AGENT =
  'gladys-vanderbilt-spc (+https://github.com/LM1LC3N7/gladys-vanderbilt-spc)';

export class GatewayClient {
  /**
   * @param {object} options
   * @param {string} options.origin `http://host:port`
   * @param {{ username: string, password: string } | null} options.credentials
   * @param {Function} [options.request] the transport (tests inject a fake gateway)
   * @param {() => number} [options.monotonic]
   * @param {(size: number) => Buffer} [options.random]
   */
  constructor({ origin, credentials = null, request = httpRequest, monotonic, random }) {
    this.origin = origin;
    this.credentials = credentials;
    this.request = request;
    this.monotonic = monotonic ?? (() => performance.now());
    this.random = random;
    /** The last challenge answered (Digest nonces are reused, `nc` counts). */
    this.challenge = null;
    /** The requests in flight: { handle, kind }. */
    this.inflight = new Set();
    this.closed = false;
  }

  /** Cut every request in flight (a new configuration, a stop). */
  close() {
    this.closed = true;
    for (const entry of this.inflight) entry.handle?.abort?.();
    this.inflight.clear();
  }

  /** Cut the reads that received no byte for `idle` ms (an arm is coming). Returns their number. */
  cutFrozenReads(idle = TIMINGS.frozenRead) {
    let count = 0;
    for (const entry of this.inflight) {
      if (entry.kind === 'read' && entry.handle?.idleFor?.() >= idle) {
        entry.handle.abort();
        count += 1;
      }
    }
    return count;
  }

  /** One exchange, its handle tracked while it runs. */
  async exchange(options, kind) {
    if (this.closed) {
      throw new GatewayError(CODES.CUT, 'Client closed', { notSent: true });
    }
    const promise = this.request({ origin: this.origin, maxBytes: LIMITS.maxBody, ...options });
    const entry = { handle: promise?.handle, kind };
    this.inflight.add(entry);
    try {
      return await promise;
    } finally {
      this.inflight.delete(entry);
    }
  }

  /**
   * A request with its authentication. `deadline` (monotonic): the whole
   * exchange ends by then; `sendBy`: no request leaves after it (commands).
   */
  async call(method, path, { deadline, sendBy, onSent, kind = 'read' } = {}) {
    const headers = { 'user-agent': USER_AGENT };
    let fresh = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const mono = this.monotonic();
      const timeout = Math.max(1, (deadline ?? mono + TIMINGS.readTimeout) - mono);
      const sendWithin = sendBy === undefined ? undefined : sendBy - mono;
      if (sendWithin !== undefined && sendWithin <= 0) {
        throw new GatewayError(CODES.NOT_SENT, 'No time left to send', { notSent: true });
      }
      const sentWith = this.credentials && this.challenge ? this.challenge : null;
      if (sentWith) {
        headers.authorization = authorization(
          sentWith,
          this.credentials,
          method,
          path,
          this.random,
        );
      } else {
        delete headers.authorization;
      }
      const answer = await this.exchange(
        { method, path, headers, timeout, sendWithin, onSent },
        kind,
      );
      if (answer.status !== 401) return answer;
      // The gateway asks for credentials.
      if (!this.credentials) {
        throw new GatewayError(CODES.AUTH_REQUIRED, 'The gateway asks for credentials', {
          status: 401,
        });
      }
      const challenge = parseChallenge(answer.headers?.['www-authenticate']);
      if (!challenge) {
        throw new GatewayError(CODES.AUTH_UNSUPPORTED, 'Authentication not supported', {
          status: 401,
        });
      }
      // Refused: credentials built on a challenge of this very exchange, or
      // Basic credentials (no nonce to expire), unless Digest says "stale".
      const refused =
        sentWith && (fresh || sentWith.scheme === 'basic') && !(challenge.stale && !fresh);
      if (refused || attempt === 1) {
        throw new GatewayError(CODES.AUTH_REFUSED, 'Credentials refused by the gateway', {
          status: 401,
        });
      }
      this.challenge = challenge;
      fresh = true;
    }
    /* c8 ignore next */
    throw new GatewayError(CODES.AUTH_REFUSED, 'Credentials refused by the gateway', {
      status: 401,
    });
  }

  /** GET a resource: its `data[resource]`, or a GatewayError. */
  async get(path, resource, options) {
    const answer = await this.call('GET', path, options);
    if (answer.status !== 200) {
      throw new GatewayError(CODES.HTTP, `HTTP ${answer.status}`, { status: answer.status });
    }
    return dataOf(answer.body, resource);
  }

  async readPanel(options) {
    return parsePanel(await this.get('/spc/panel', 'panel', options));
  }

  async readAreas(options) {
    return parseList(await this.get('/spc/area', 'area', options), parseArea, LIMITS.maxAreas);
  }

  async readZones(options) {
    return parseList(await this.get('/spc/zone', 'zone', options), parseZone, LIMITS.maxZones);
  }

  async readArea(id, options) {
    return parseOne(await this.get(`/spc/area/${id}`, 'area', options), parseArea, id);
  }

  async readZone(id, options) {
    return parseOne(await this.get(`/spc/zone/${id}`, 'zone', options), parseZone, id);
  }

  /**
   * PUT the mode of an area. Resolves when the gateway reports a success;
   * a GatewayError else (FAILED: the panel refused it, e.g. a zone open).
   */
  async setMode(id, mode, { deadline, sendBy, onSent }) {
    const command = COMMAND_OF_MODE[mode];
    if (!command) throw new Error(`Unknown mode ${mode}`);
    const answer = await this.call('PUT', `/spc/area/${id}/${command}`, {
      deadline,
      sendBy,
      onSent,
      kind: 'command',
    });
    if (answer.status !== 200) {
      throw new GatewayError(CODES.HTTP, `HTTP ${answer.status}`, { status: answer.status });
    }
    dataOf(answer.body);
  }
}
