// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), the
// real HTTP transport and the real websocket (`ws`) against the fake gateway
// on loopback, with Digest authentication: the reads really start, at 0, the
// interval and twice the interval; an event reads its zone; a set goes out.
// Time sped up 20 times (60 s are 3 s), but the real clock: it moves
// between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SpcApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { createdDevices, device, feature } from './helpers/app.js';
import { createFakeGateway } from './helpers/fakeGateway.js';
import { listen } from './helpers/server.js';

const SPEED = 20;
const INTERVAL = TIMINGS.poll;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('real clock and transports: reads at 0, 60 s, 120 s; events; a set; credentials never in clear', async () => {
  const fake = createFakeGateway({
    auth: { scheme: 'digest', username: 'gladys', password: 'S3cret pass' },
  });
  fake.timers = { setTimeout, clearTimeout };
  fake.clock = {
    get now() {
      return Date.now();
    },
  };
  const server = await listen(fake);
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const config = { host: `127.0.0.1:${server.port}`, username: 'gladys', password: 'S3cret pass' };
  const gladys = createFakeGladys({
    selector: 'vanderbilt-spc',
    config,
    devices: createdDevices(fake, config),
  });
  await gladys.connect();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => logs.push(`${l} ${a.join(' ')}`)]),
  );
  const app = new SpcApp({
    gladys,
    logger,
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app, logger);
  const started = performance.now();
  const areaReads = () =>
    server.requests.filter((r) => r.url === '/spc/area' && r.headers.authorization);
  try {
    await app.start(config);
    while (areaReads().length < 3 && performance.now() - started < (3.5 * INTERVAL) / SPEED) {
      await sleep(5);
    }
    // The websocket: open with Digest, an event reads its zone.
    assert.equal(server.sockets.size, 1, logs.join('\n'));
    assert.equal(server.handshakes.at(-1).url, '/ws/spc');
    fake.zones.get('3').input = '1';
    server.send(JSON.stringify({ data: { sia: { sia_code: 'ZO', sia_address: '3' } } }));
    await sleep(50);
    assert.ok(server.requests.some((r) => r.url === '/spc/zone/3'));
    // A set over the real transport.
    const area = device(gladys.fake.devices, 'area', '1');
    const answer = await gladys.fake.setValue(area, feature(area, 'arm-full'), 1);
    assert.deepEqual(answer, { success: true });
    assert.equal(fake.areas.get('1').mode, '3');
  } finally {
    await app.stop();
    await server.close();
  }
  // The start of each read: its first request (the first one answered by a
  // Digest challenge, then sent again with the credentials).
  const all = server.requests
    .filter((r) => r.url === '/spc/area')
    .map((r) => (r.at - started) * SPEED);
  const at = all.filter((t, i) => i === 0 || t - all[i - 1] > 5_000);
  assert.equal(at.length, 3, `reads at ${at.map(Math.round)}`);
  assert.ok(at[0] < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < at.length; i += 1) {
    const gap = at[i] - at[i - 1];
    assert.ok(gap >= 0.9 * INTERVAL && gap < 1.5 * INTERVAL, `period: ${at.map(Math.round)}`);
  }
  assert.ok(timersSet < 40, `${timersSet} timers`);
  // Never the password in clear: not in a header, not in a URL, not in a log.
  for (const r of server.requests) {
    assert.ok(!JSON.stringify(r).includes('S3cret'), r.url);
    assert.doesNotMatch(r.headers.authorization ?? '', /^Basic/);
  }
  for (const h of server.handshakes) assert.ok(!JSON.stringify(h).includes('S3cret'));
  assert.ok(!logs.join('\n').includes('S3cret'));
});
