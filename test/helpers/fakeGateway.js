// -----------------------------------------------------------------------------
// A fake SPC Web Gateway in memory: the REST answers and the websocket of the
// gateway, with the shapes of the pyspcwebgw test fixtures (MIT); never
// checked against a real gateway (TODO.md). Its timers are the fake clock's.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { CODES, GatewayError } from '../../src/spc/errors.js';

export const SERIAL = 'DEADBEEF';
export const OTHER_SERIAL = 'CAFEF00D';

const MODE_CODE = { set: '3', set_a: '1', set_b: '2', unset: '0' };

export function defaultAreas() {
  return [
    {
      id: '1',
      name: 'House',
      mode: '0',
      last_set_time: '1485759851',
      last_set_user_id: '1',
      last_set_user_name: 'Pelle',
      last_unset_time: '1485800564',
      last_unset_user_id: '1',
      last_unset_user_name: 'Pelle',
      last_alarm: '1478174896',
    },
    {
      id: '3',
      name: 'Garage',
      mode: '0',
      last_set_time: '1483705803',
      last_set_user_id: '9998',
      last_set_user_name: 'Lisa',
      last_unset_time: '1483705808',
      last_unset_user_id: '9998',
      last_unset_user_name: 'Lisa',
    },
  ];
}

export function defaultZones() {
  const zone = (id, type, name, area, input = '0') => ({
    id,
    type,
    zone_name: name,
    area,
    area_name: area === '1' ? 'House' : 'Garage',
    input,
    logic_input: '0',
    status: '0',
    proc_state: '0',
    inhibit_allowed: '1',
    isolate_allowed: '1',
  });
  return [
    zone('1', '3', 'Kitchen smoke', '1'),
    zone('3', '0', 'Garage PIR', '3'),
    zone('4', '0', 'Garage door', '3'),
    zone('5', '1', 'Front door', '1', '1'),
    zone('6', '12', 'Unused', '1'),
  ];
}

const md5 = (text) => createHash('md5').update(text).digest('hex');

export function createFakeGateway({
  areas = defaultAreas(),
  zones = defaultZones(),
  serial = SERIAL,
  auth = null,
} = {}) {
  const fake = {
    areas: new Map(areas.map((a) => [a.id, { ...a }])),
    zones: new Map(zones.map((z) => [z.id, { ...z }])),
    panel: {
      cfgtime: '1593425759',
      'device-id': '1',
      sn: serial,
      type: 'SPC4000',
      variant: '4300',
      version: '3.8.5 - R.31629',
    },
    /** { scheme: 'digest' | 'basic', username, password }: the gateway asks for it. */
    auth,
    nonce: 'nonce-1',
    requests: [],
    /** Behaviours, first match wins: { method?, path? (RegExp or string), action, times, ... }. */
    behaviors: [],
    /** Answer delay of every request (ms of the fake clock). */
    latency: 0,
    /** A command applies this long after its answer (0: before it). */
    applyDelay: 0,
    /** The panel refuses the commands ({ status: 'failed' }). */
    refuseCommands: false,
    timers: null,
    clock: null,
    sockets: [],
  };

  const now = () => fake.clock?.now ?? 0;
  const later = (fn, ms) => (ms > 0 ? fake.timers.setTimeout(fn, ms) : queueMicrotask(fn));

  const ok = (data) => ({
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify({ status: 'success', data })),
  });

  function authorized(method, path, header) {
    if (!fake.auth) return true;
    if (typeof header !== 'string') return false;
    if (fake.auth.scheme === 'basic') {
      const expected = Buffer.from(`${fake.auth.username}:${fake.auth.password}`).toString(
        'base64',
      );
      return header === `Basic ${expected}`;
    }
    const params = Object.fromEntries(
      [...header.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)].map((m) => [m[1], m[2] ?? m[3]]),
    );
    if (params.nonce !== fake.nonce || params.username !== fake.auth.username) return false;
    const ha1 = md5(`${fake.auth.username}:SPC:${fake.auth.password}`);
    const ha2 = md5(`${method}:${path}`);
    const expected = md5(`${ha1}:${params.nonce}:${params.nc}:${params.cnonce}:auth:${ha2}`);
    return params.response === expected && params.uri === path;
  }

  const challenge = (stale = false) =>
    fake.auth.scheme === 'basic'
      ? 'Basic realm="SPC"'
      : `Digest realm="SPC", nonce="${fake.nonce}", qop="auth", algorithm=MD5${stale ? ', stale=true' : ''}`;

  function answer(method, path, headers) {
    if (!authorized(method, path, headers.authorization)) {
      return { status: 401, headers: { 'www-authenticate': challenge() }, body: Buffer.from('') };
    }
    let m;
    if (method === 'GET' && path === '/spc/panel') return ok({ panel: fake.panel });
    if (method === 'GET' && path === '/spc/area') return ok({ area: [...fake.areas.values()] });
    if (method === 'GET' && path === '/spc/zone') return ok({ zone: [...fake.zones.values()] });
    if (method === 'GET' && (m = /^\/spc\/area\/(\d+)$/.exec(path))) {
      const area = fake.areas.get(m[1]);
      return area ? ok({ area: [area] }) : { status: 404, headers: {}, body: Buffer.from('') };
    }
    if (method === 'GET' && (m = /^\/spc\/zone\/(\d+)$/.exec(path))) {
      const zone = fake.zones.get(m[1]);
      return zone ? ok({ zone }) : { status: 404, headers: {}, body: Buffer.from('') };
    }
    if (method === 'PUT' && (m = /^\/spc\/area\/(\d+)\/(set|set_a|set_b|unset)$/.exec(path))) {
      const area = fake.areas.get(m[1]);
      if (!area) return { status: 404, headers: {}, body: Buffer.from('') };
      if (fake.refuseCommands) {
        return { status: 200, headers: {}, body: Buffer.from('{"status":"failed"}') };
      }
      const apply = () => fake.setMode(m[1], MODE_CODE[m[2]]);
      if (fake.applyDelay > 0) fake.timers.setTimeout(apply, fake.applyDelay);
      else apply();
      return { status: 200, headers: {}, body: Buffer.from('{"status":"success"}') };
    }
    return { status: 404, headers: {}, body: Buffer.from('') };
  }

  fake.wsAuthorized = (req) => authorized('GET', req.url, req.headers.authorization);
  fake.wsChallenge = () => (fake.auth ? challenge() : 'Basic realm="SPC"');

  /** The mode of an area changes (a keypad, a command): its times follow. */
  fake.setMode = (id, code) => {
    const area = fake.areas.get(id);
    area.mode = code;
    const seconds = String(Math.floor(now() / 1000));
    if (code === '0') area.last_unset_time = seconds;
    else area.last_set_time = seconds;
  };

  const matches = (b, method, path) =>
    (b.method === undefined || b.method === method) &&
    (b.path === undefined || (b.path instanceof RegExp ? b.path.test(path) : b.path === path)) &&
    (b.times === undefined || b.times > 0);

  fake.request = ({ method, path, headers = {}, timeout, sendWithin, onSent }) => {
    let settle;
    let lastByte = now();
    let connected = false;
    const entry = { method, path, at: now(), authorization: Boolean(headers.authorization) };
    fake.requests.push(entry);
    const behavior = fake.behaviors.find((b) => matches(b, method, path));
    if (behavior && behavior.times !== undefined) behavior.times -= 1;
    const handle = {
      abort: () => settle?.(new GatewayError(CODES.CUT, 'Request cut', { notSent: !connected })),
      idleFor: () => now() - lastByte,
      get connected() {
        return connected;
      },
    };
    const promise = new Promise((resolve, reject) => {
      let done = false;
      const timers = [];
      settle = (err, value) => {
        if (done) return;
        done = true;
        for (const t of timers) fake.timers.clearTimeout(t);
        if (err) reject(err);
        else resolve(value);
      };
      timers.push(
        fake.timers.setTimeout(
          () => settle(new GatewayError(CODES.TIMEOUT, 'No answer', { notSent: !connected })),
          timeout,
        ),
      );
      const action = behavior?.action;
      if (action === 'down') {
        const fail = () =>
          settle(new GatewayError(CODES.UNREACHABLE, 'ECONNREFUSED', { notSent: true }));
        if (behavior.delay) timers.push(fake.timers.setTimeout(fail, behavior.delay));
        else queueMicrotask(fail);
        return;
      }
      if (action === 'noconnect') {
        // The connection never comes up: not sent past sendWithin.
        if (sendWithin !== undefined) {
          timers.push(
            fake.timers.setTimeout(
              () => settle(new GatewayError(CODES.NOT_SENT, 'Not connected', { notSent: true })),
              Math.max(0, sendWithin),
            ),
          );
        }
        return;
      }
      connected = true;
      entry.sent = true;
      onSent?.();
      if (action === 'hang') return; // connected, never answers
      if (action === 'status') {
        later(
          () => settle(null, { status: behavior.status, headers: {}, body: Buffer.from('') }),
          behavior.delay ?? fake.latency,
        );
        return;
      }
      if (action === 'reset') {
        later(
          () => settle(new GatewayError(CODES.RESET, 'Connection closed')),
          behavior.delay ?? fake.latency,
        );
        return;
      }
      if (action === 'body') {
        later(
          () => settle(null, { status: 200, headers: {}, body: Buffer.from(behavior.body) }),
          behavior.delay ?? fake.latency,
        );
        return;
      }
      const delay = behavior?.delay ?? fake.latency;
      const reply = () => {
        lastByte = now();
        try {
          settle(null, answer(method, path, headers));
        } catch (err) {
          settle(err);
        }
      };
      if (delay > 0) timers.push(fake.timers.setTimeout(reply, delay));
      else queueMicrotask(reply);
    });
    promise.handle = handle;
    return promise;
  };

  /** The websocket: a fake `ws` client per connection. */
  fake.socketFactory = (url, options) => {
    const socket = new EventEmitter();
    socket.url = url;
    socket.options = options;
    socket.readyState = 0;
    socket.pings = 0;
    socket.ping = () => {
      socket.pings += 1;
      if (!fake.silentPong) queueMicrotask(() => socket.emit('pong'));
    };
    socket.terminate = () => {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      queueMicrotask(() => socket.emit('close', 1006));
    };
    fake.sockets.push(socket);
    queueMicrotask(() => {
      if (socket.readyState === 3) return;
      if (fake.wsRefuse) {
        socket.emit(
          'unexpected-response',
          {},
          { statusCode: fake.wsRefuse, headers: {}, resume() {} },
        );
        return;
      }
      if (fake.wsDown) {
        socket.readyState = 3;
        socket.emit('error', new Error('ECONNREFUSED'));
        socket.emit('close', 1006);
        return;
      }
      socket.readyState = 1;
      socket.emit('open');
    });
    return socket;
  };

  /** A SIA event pushed on every open websocket. */
  fake.push = (code, address, description = 'x') => {
    const text = JSON.stringify({
      data: { sia: { sia_code: code, sia_address: address, description } },
    });
    for (const socket of fake.sockets) {
      if (socket.readyState === 1) socket.emit('message', Buffer.from(text), false);
    }
  };

  fake.openSockets = () => fake.sockets.filter((s) => s.readyState === 1);
  fake.count = (method, path) =>
    fake.requests.filter(
      (r) => r.method === method && (path instanceof RegExp ? path.test(r.path) : r.path === path),
    ).length;

  return fake;
}
