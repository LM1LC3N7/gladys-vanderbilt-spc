// -----------------------------------------------------------------------------
// The app: reads, pace, events, freshness, identity, credentials, /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { createFakeGateway, OTHER_SERIAL, SERIAL } from './helpers/fakeGateway.js';
import { createdDevices, featureId, MINUTE, SECOND, setup, T0 } from './helpers/app.js';

const reads = (fake) =>
  fake.requests.filter((r) => r.path === '/spc/area').map((r) => Math.round(r.at - T0));

test('first start: the areas, the serial, the zones; Discovery, states, status, websocket', async () => {
  const { gladys, fake, store } = await setup();
  assert.deepEqual(
    fake.requests.map((r) => `${r.method} ${r.path}`),
    ['GET /spc/area', 'GET /spc/panel', 'GET /spc/zone'],
  );
  const discovered = gladys.fake.discoveredDevices;
  assert.equal(discovered.length, 1 + 2 + 4, 'panel, 2 areas, 4 zones (the unused one skipped)');
  assert.equal(discovered.find((d) => d.external_id.endsWith(':area:1')).name, 'House');
  for (const d of discovered) {
    for (const f of d.features) {
      assert.notEqual(f.category, 'switch', `${f.external_id} is never a switch`);
    }
  }
  assert.equal(gladys.fake.lastState(featureId('area', '1', 'mode')), 'Hors service');
  assert.equal(gladys.fake.lastState(featureId('area', '1', 'armed')), 0);
  assert.equal(gladys.fake.lastState(featureId('zone', '5', 'opening')), 0, 'front door open');
  assert.equal(gladys.fake.lastState(featureId('zone', '4', 'motion')), 0);
  assert.equal(gladys.fake.lastState(featureId('zone', '1', 'smoke')), 0);
  assert.equal(gladys.fake.lastState(featureId('panel', null, 'online')), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /2 area\(s\), 4 zone\(s\)\. Live events/);
  assert.equal(fake.openSockets().length, 1);
  assert.equal(fake.sockets[0].url, 'ws://192.168.1.10:8088/ws/spc');
  assert.equal(store.data.panel, SERIAL);
});

test('pace: every 60 s on a clock that moves, never sooner after a restart', async () => {
  const { fake, wait } = await setup();
  await wait(3 * MINUTE);
  assert.deepEqual(reads(fake), [0, MINUTE, 2 * MINUTE, 3 * MINUTE]);
  // A restart 20 s after a read: the next one 40 s later.
  const store = memoryStore({ panel: SERIAL, lastAttemptAt: T0 - 20 * SECOND });
  const again = await setup({ store });
  assert.deepEqual(reads(again.fake), []);
  await again.wait(40 * SECOND);
  assert.deepEqual(reads(again.fake), [40 * SECOND]);
});

test('failures: link down, next try never sooner than 60 s, growing; back on its own', async () => {
  const fake = createFakeGateway();
  fake.behaviors.push({ path: '/spc/area', action: 'down', times: 3 });
  const { gladys, wait } = await setup({ fake });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer \(no connection\)/);
  assert.equal(gladys.fake.lastState(featureId('panel', null, 'online')), 0);
  await wait(10 * MINUTE);
  const at = reads(fake);
  assert.deepEqual(at.slice(0, 4), [0, MINUTE, 2 * MINUTE, 4 * MINUTE]);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('an answer that is not the gateway: said so', async () => {
  const fake = createFakeGateway();
  fake.behaviors.push({ path: '/spc/area', action: 'body', body: '<html>' });
  const { gladys } = await setup({ fake });
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer like an SPC Web Gateway/);
});

test('freshness: values older than 150 s are not published again', async () => {
  const fake = createFakeGateway();
  const { gladys, app, wait } = await setup({ fake });
  fake.behaviors.push({ path: '/spc/area', action: 'hang' });
  await wait(3 * MINUTE);
  const before = gladys.fake.states.length;
  await app.publishStates();
  const published = gladys.fake.states.slice(before);
  assert.ok(published.every((s) => s.device_feature_external_id.endsWith(':panel:spc:online')));
});

test('websocket: an event reads what it names, a burst reads everything, a flood closes it', async () => {
  const { gladys, fake, wait } = await setup();
  fake.zones.get('3').input = '1';
  fake.push('ZO', '3');
  await wait(0);
  assert.equal(fake.count('GET', '/spc/zone/3'), 1);
  assert.equal(gladys.fake.lastState(featureId('zone', '3', 'motion')), 1);
  // An area event.
  fake.setMode('3', '1');
  fake.push('NL', '3', 'Garage¦Lisa¦9998');
  await wait(SECOND);
  assert.equal(gladys.fake.lastState(featureId('area', '3', 'mode')), 'Partielle A');
  // CL / OP: every area.
  fake.push('CL', '9998');
  await wait(SECOND);
  assert.equal(fake.count('GET', '/spc/area/1'), 1);
  // Unknown ids and codes: nothing read.
  const count = fake.requests.length;
  fake.push('ZO', '99');
  fake.push('XX', '1');
  fake.sockets[0].emit('message', Buffer.from('not json'), false);
  await wait(SECOND);
  assert.equal(fake.requests.length, count);
  // A burst: one read of everything.
  for (let i = 0; i < 40; i += 1) {
    fake.push('ZC', '3');
    fake.push('ZC', '4');
    fake.push('ZC', '5');
    fake.push('NL', '1');
  }
  await wait(SECOND);
  assert.ok(fake.count('GET', '/spc/zone/4') <= 2);
  // A flood: closed, reopened 15 s later.
  for (let i = 0; i < 700; i += 1) fake.push('ZC', '3');
  await wait(0);
  assert.equal(fake.openSockets().length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /websocket closed/);
  await wait(15 * SECOND);
  assert.equal(fake.openSockets().length, 1);
});

test('websocket: a dead socket (no pong) is closed and opened again', async () => {
  const { fake, wait } = await setup();
  fake.silentPong = true;
  await wait(61 * SECOND);
  assert.equal(fake.sockets[0].readyState, 3);
  fake.silentPong = false;
  await wait(15 * SECOND);
  assert.equal(fake.openSockets().length, 1);
});

test('websocket refused (401): the reads go on, said in the status', async () => {
  const fake = createFakeGateway();
  fake.wsRefuse = 401;
  const { gladys, wait } = await setup({ fake });
  assert.match(gladys.fake.connectionStatus.message.en, /websocket of the gateway refuses/);
  await wait(5 * MINUTE);
  assert.equal(fake.sockets.length, 1, 'never tried again with the same configuration');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('credentials refused: kept in /data (8-bit marker), no try after a restart, new ones lift it', async () => {
  const fake = createFakeGateway({ auth: { scheme: 'digest', username: 'u', password: 'good' } });
  const store = memoryStore();
  const first = await setup({ fake, store, config: { username: 'u', password: 'bad' } });
  assert.match(
    first.gladys.fake.connectionStatus.message.en,
    /refuses the user name or the password/,
  );
  assert.match(store.data.refused.mark, /^[0-9a-f]{2}$/);
  assert.ok(!JSON.stringify(store.data).includes('bad'));
  assert.ok(!first.logs.join('\n').includes('bad'));
  await first.wait(10 * MINUTE);
  assert.equal(fake.requests.length, 2, 'no new try by itself');
  // A restart with the same credentials: nothing sent.
  fake.requests.length = 0;
  const again = await setup({
    fake,
    store,
    now: T0 + 20 * MINUTE,
    config: { username: 'u', password: 'bad' },
  });
  assert.equal(fake.requests.length, 0);
  // A press is refused without a request.
  const answer = await again.pressFor('1', 'arm-full');
  assert.equal(answer.success, false);
  assert.match(answer.error, /refuses the user name or the password/);
  assert.equal(fake.requests.length, 0);
  // "Test the connection": one try.
  const test1 = await again.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.equal(test1.success, false);
  assert.equal(fake.requests.length, 2);
  // New credentials: they are tried, the refusal is erased.
  await again.gladys.fake.configUpdated({ host: '192.168.1.10', username: 'u', password: 'good' });
  await again.wait(0);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refused, null);
});

test('a 401 on the zones only (areas read with the same credentials) is not a refusal', async () => {
  const fake = createFakeGateway();
  fake.behaviors.push({ path: '/spc/zone', action: 'status', status: 401 });
  const { gladys, store } = await setup({ fake });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /zones could not be read/);
  assert.equal(store.data.refused, null);
});

test('the gateway asks for credentials and none are given: said, no loop', async () => {
  const fake = createFakeGateway({ auth: { scheme: 'basic', username: 'u', password: 'p' } });
  const { gladys, wait } = await setup({ fake });
  assert.match(gladys.fake.connectionStatus.message.en, /asks for a user name and a password/);
  await wait(10 * MINUTE);
  assert.equal(fake.requests.length, 1);
});

test('another panel at the address: nothing published nor sent until the user accepts it', async () => {
  const fake = createFakeGateway();
  const store = memoryStore({ panel: 'OLD12345' });
  fake.panel.sn = OTHER_SERIAL;
  const { gladys, pressFor } = await setup({ fake, store });
  assert.match(gladys.fake.connectionStatus.message.en, /Another panel answers.*CAFEF00D/);
  assert.equal(gladys.fake.lastState(featureId('area', '1', 'mode')), undefined);
  const answer = await pressFor('1', 'arm-full');
  assert.match(answer.error, /Another panel answers/);
  assert.equal(fake.count('PUT', /set/), 0);
  const accepted = await gladys.fake.action(ACTIONS.ACCEPT_PANEL);
  assert.equal(accepted.success, true);
  assert.equal(store.data.panel, OTHER_SERIAL);
  const nothing = await gladys.fake.action(ACTIONS.ACCEPT_PANEL);
  assert.equal(nothing.success, false);
});

test('Gladys reconnects: status, Discovery and states again, no read sooner than the pace', async () => {
  const { gladys, fake, wait } = await setup();
  await wait(10 * SECOND);
  const count = fake.requests.length;
  const statuses = gladys.fake.connectionStatuses.length;
  await gladys.connect();
  await wait(0);
  assert.equal(fake.requests.length, count);
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
});

test('getConfig() failing at the start: asked again without end, said in the status', async () => {
  const { gladys, app, wait } = await setup({ connect: false });
  let calls = 0;
  const original = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('down'), { status: 503 });
    return original();
  };
  await app.startFromGladys();
  await wait(0);
  assert.match(gladys.fake.connectionStatus.message.en, /configuration of Gladys is not read yet/);
  await wait(2 * MINUTE);
  assert.equal(calls, 3);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('/data unreadable: no read (it would overwrite it), said, tried again', async () => {
  const store = memoryStore(null, { unreadable: true });
  const { gladys, fake, wait } = await setup({ store });
  assert.match(gladys.fake.connectionStatus.message.en, /cannot be read/);
  assert.equal(fake.requests.length, 0);
  store.unreadable = false;
  await wait(MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('invalid configurations: said, never shown back', async () => {
  const { gladys } = await setup({ config: { host: 'http://u:secretpw@10.0.0.1' } });
  assert.match(gladys.fake.connectionStatus.message.en, /must not carry a user name/);
  assert.ok(!JSON.stringify(gladys.fake.connectionStatuses).includes('secretpw'));
  const other = await setup({ config: { password: 'lonely' } });
  assert.match(
    other.gladys.fake.connectionStatus.message.en,
    /password is given without a user name/,
  );
  const kinds = await setup({ config: { zone_kinds: '5:opening, mypassword' } });
  assert.match(kinds.gladys.fake.connectionStatus.message.en, /1 entry\(ies\) of "Zone kinds"/);
  assert.ok(!JSON.stringify(kinds.gladys.fake.connectionStatuses).includes('mypassword'));
});

test('a zone kind configured shows after Update: the states go to the kind the device has', async () => {
  const { gladys } = await setup({
    config: { zone_kinds: '4:opening' },
    created: createdDevices(),
  });
  const discovered = gladys.fake.discoveredDevices.find((d) => d.external_id.endsWith(':zone:4'));
  const keys = discovered.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(keys.includes('motion'), 'the created feature is kept');
  assert.equal(gladys.fake.lastState(featureId('zone', '4', 'motion')), 0);
});

test('alarm: a zone in alarm, or a verified alarm while set, shows on the area', async () => {
  const { gladys, fake, wait } = await setup();
  fake.setMode('1', '3');
  fake.push('BV', '1');
  await wait(SECOND);
  assert.equal(gladys.fake.lastState(featureId('area', '1', 'alarm')), 1);
  assert.equal(gladys.fake.lastState(featureId('area', '1', 'mode')), 'Alarme');
  fake.setMode('1', '0');
  fake.push('OG', '1');
  await wait(SECOND);
  assert.equal(gladys.fake.lastState(featureId('area', '1', 'alarm')), 0);
  fake.zones.get('3').status = '5';
  fake.push('BA', '3');
  await wait(SECOND);
  assert.equal(gladys.fake.lastState(featureId('zone', '3', 'alarm')), 1);
  await wait(MINUTE);
  assert.equal(gladys.fake.lastState(featureId('area', '3', 'alarm')), 1);
});
