// -----------------------------------------------------------------------------
// The commands: set (arm) always protective, unset (disarm) opt-in, guards.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { createFakeGateway, SERIAL } from './helpers/fakeGateway.js';
import { device, feature, featureId, MINUTE, SECOND, setup, T0 } from './helpers/app.js';

const puts = (fake, area = '\\d+') =>
  fake.requests
    .filter((r) => r.method === 'PUT' && new RegExp(`^/spc/area/${area}/`).test(r.path))
    .map((r) => `${r.path.split('/').at(-1)}@${Math.round(r.at - T0)}`);

const ALLOW = { allow_disarm: true };

test('full set: sent at once, confirmed by the area read back', async () => {
  const { fake, gladys, pressFor } = await setup();
  const answer = await pressFor('1', 'arm-full');
  assert.deepEqual(answer, { success: true });
  assert.deepEqual(puts(fake), ['set@0']);
  assert.equal(gladys.fake.lastState(featureId('area', '1', 'armed')), 1);
  assert.equal(gladys.fake.lastState(featureId('area', '1', 'mode')), 'Totale');
});

test('set before the first read: no read, no option, no identity needed', async () => {
  const fake = createFakeGateway();
  // The reads hang (a gateway slow to start): the set never waits for them.
  fake.behaviors.push({ method: 'GET', action: 'hang' });
  const { pressFor } = await setup({ fake, store: memoryStore(null, { unreadable: true }) });
  fake.behaviors.length = 0;
  const answer = await pressFor('1', 'arm-full');
  assert.equal(answer.success, true);
  assert.equal(fake.areas.get('1').mode, '3');
});

test('set while the reads fail and wait (backoff): sent at once', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait } = await setup({ fake });
  fake.behaviors.push({ method: 'GET', path: '/spc/area', action: 'status', status: 500 });
  await wait(2 * MINUTE);
  const answer = await pressFor('3', 'arm-full');
  assert.equal(answer.success, true);
  assert.equal(fake.areas.get('3').mode, '3');
});

test('set: tried again every 250 ms while the request does not reach the gateway', async () => {
  const fake = createFakeGateway();
  const { pressFor } = await setup({ fake });
  fake.behaviors.push({ method: 'PUT', action: 'down', times: 3, delay: 100 });
  const answer = await pressFor('1', 'arm-full');
  assert.equal(answer.success, true);
  const at = puts(fake);
  assert.equal(at.length, 4);
  assert.equal(fake.areas.get('1').mode, '3');
});

test('set never delivered: sent again by a fresh read when nothing moved at the panel', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait, store } = await setup({ fake });
  fake.behaviors.push({ method: 'PUT', action: 'down', times: 20 });
  const answer = await pressFor('1', 'arm-full');
  assert.equal(answer.success, false);
  assert.match(answer.error, /^Not sent: the gateway did not take the request/);
  assert.equal(store.data.guards.length, 1);
  assert.equal(fake.areas.get('1').mode, '0');
  fake.behaviors.length = 0;
  await wait(20 * SECOND);
  assert.equal(fake.areas.get('1').mode, '3', 'sent again by the follow-up read');
  await wait(10 * SECOND);
  assert.equal(store.data.guards.length, 0);
});

test('set never delivered, the area unset at the keypad meanwhile: never sent again', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  const { pressFor, wait, gladys } = await setup({ fake });
  fake.setMode('1', '0');
  fake.behaviors.push({ method: 'PUT', action: 'down', times: 20 });
  // The reference is the last read (full set): the area moved since.
  await pressFor('1', 'arm-full');
  const tries = puts(fake).length;
  fake.behaviors.length = 0;
  await wait(5 * MINUTE);
  assert.equal(puts(fake).length, tries);
  assert.equal(fake.areas.get('1').mode, '0');
  assert.match(gladys.fake.connectionStatus.message.en, /changed at the panel since/);
});

test('set never delivered, an event of the panel since the press: never sent again', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait } = await setup({ fake });
  fake.behaviors.push({ method: 'PUT', action: 'down', times: 20 });
  await pressFor('1', 'arm-full');
  const tries = puts(fake).length;
  fake.push('OP', '9998');
  fake.behaviors.length = 0;
  await wait(5 * MINUTE);
  assert.equal(puts(fake).length, tries);
  assert.equal(fake.areas.get('1').mode, '0');
});

test('set never delivered, the gateway back 4 min later: not sent, the status says to set again', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait, gladys } = await setup({ fake });
  fake.behaviors.push({ method: 'PUT', action: 'down' });
  fake.behaviors.push({ method: 'GET', action: 'down' });
  await pressFor('1', 'arm-full');
  const tries = puts(fake).length;
  await wait(4 * MINUTE);
  fake.behaviors.length = 0;
  await wait(5 * MINUTE);
  assert.equal(puts(fake).length, tries);
  assert.equal(fake.areas.get('1').mode, '0');
  assert.match(gladys.fake.connectionStatus.message.en, /never reached the gateway: set it again/);
});

test('set accepted, applied 30 s later (exit time): "sent, not yet shown", no new send', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait, gladys } = await setup({ fake });
  fake.applyDelay = 30 * SECOND;
  const answer = await pressFor('1', 'arm-full');
  assert.match(answer.error, /^Sent and accepted by the gateway, not yet shown/);
  await wait(2 * MINUTE);
  assert.equal(puts(fake).length, 1);
  assert.equal(gladys.fake.lastState(featureId('area', '1', 'mode')), 'Totale');
});

test('set accepted but never shown (a zone open): never sent again, said in the status', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait, gladys } = await setup({ fake });
  fake.ignoreCommands = true;
  await pressFor('1', 'arm-full');
  // The occupant closes the door 30 s later: the area must not set itself.
  await wait(30 * SECOND);
  fake.ignoreCommands = false;
  await wait(10 * MINUTE);
  assert.equal(puts(fake).length, 1);
  assert.equal(fake.areas.get('1').mode, '0');
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /accepted by the gateway but the area does not show it 60 s later.*not sent again/,
  );
});

test('exit time cancelled at the keypad by the occupant: never set again', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait } = await setup({ fake });
  fake.applyDelay = 45 * SECOND;
  await pressFor('1', 'arm-full');
  await wait(10 * SECOND);
  fake.keypadUnset('1');
  fake.push('OP', '1');
  await wait(10 * MINUTE);
  assert.equal(puts(fake).length, 1);
  assert.equal(fake.areas.get('1').mode, '0');
});

test('set, then unset by someone at the keypad: never set again by the guard', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait } = await setup({ fake });
  fake.applyDelay = 30 * SECOND;
  await pressFor('1', 'arm-full');
  // Set at 30 s; unset at the keypad at 40 s, before the 60 s read.
  await wait(35 * SECOND);
  fake.applyDelay = 0;
  fake.setMode('1', '0');
  await wait(3 * MINUTE);
  assert.equal(puts(fake).length, 1);
  assert.equal(fake.areas.get('1').mode, '0');
});

test('part set: never lowers a full set, never replaces the other part set', async () => {
  const fake = createFakeGateway();
  const { pressFor } = await setup({ fake });
  fake.setMode('1', '3');
  const lower = await pressFor('1', 'arm-part-a');
  assert.equal(lower.success, true);
  assert.equal(fake.areas.get('1').mode, '3');
  fake.setMode('3', '2');
  const other = await pressFor('3', 'arm-part-a');
  assert.match(other.error, /Part set B: nothing sent/);
  assert.equal(puts(fake).length, 0);
  // From unset: sent.
  fake.setMode('3', '0');
  const ok = await pressFor('3', 'arm-part-b');
  assert.equal(ok.success, true);
  assert.equal(fake.areas.get('3').mode, '2');
});

test('part set, state not readable: sent only when the last state known is unset', async () => {
  const fake = createFakeGateway();
  const { pressFor } = await setup({ fake });
  fake.behaviors.push({ method: 'GET', path: '/spc/area/1', action: 'hang', times: 1 });
  const sent = await pressFor('1', 'arm-part-a');
  assert.equal(fake.areas.get('1').mode, '1', `${JSON.stringify(sent)}`);
  // Known as set: not readable -> refused, nothing sent.
  fake.setMode('3', '3');
  const fresh = createFakeGateway();
  fresh.setMode('1', '3');
  const second = await setup({ fake: fresh });
  fresh.behaviors.push({ method: 'GET', path: '/spc/area/1', action: 'down' });
  const refused = await second.pressFor('1', 'arm-part-a');
  assert.match(refused.error, /a part set could lower a full set/);
  assert.equal(puts(fresh).length, 0);
});

test('unset: off by default, nothing sent', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  const { pressFor, logs } = await setup({ fake });
  const answer = await pressFor('1', 'disarm');
  assert.match(answer.error, /Unsetting from Gladys is disabled/);
  assert.equal(puts(fake).length, 0);
  assert.ok(logs.some((l) => /REFUSED/.test(l)));
});

test('unset allowed: decided on a fresh read, written, confirmed', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  const { pressFor } = await setup({ fake, config: ALLOW });
  const before = fake.count('GET', '/spc/area/1');
  const answer = await pressFor('1', 'disarm');
  assert.deepEqual(answer, { success: true });
  assert.ok(fake.count('GET', '/spc/area/1') >= before + 2, 'read before, read after');
  assert.equal(fake.areas.get('1').mode, '0');
  // Already unset: nothing sent.
  const again = await pressFor('1', 'disarm');
  assert.equal(again.success, true);
  assert.equal(puts(fake).length, 1);
});

test('unset: refused while the serial of the panel is not read in this session', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  fake.behaviors.push({ path: '/spc/panel', action: 'status', status: 500 });
  const { pressFor, gladys } = await setup({
    fake,
    config: ALLOW,
    store: memoryStore({ panel: SERIAL }),
  });
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /serial number of the panel is not read yet/,
  );
  const answer = await pressFor('1', 'disarm');
  assert.match(answer.error, /serial number of the panel is not read yet/);
  assert.equal(puts(fake).length, 0);
  // Setting is not held back by it.
  fake.setMode('3', '0');
  assert.equal((await pressFor('3', 'arm-full')).success, true);
});

test('unset: state not read, nothing sent; the option checked again right before the write', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  const { pressFor, app } = await setup({ fake, config: ALLOW });
  fake.behaviors.push({ path: '/spc/area/1', action: 'down', times: 1 });
  const unread = await pressFor('1', 'disarm');
  assert.match(unread.error, /State of the area not read \(no connection\): nothing sent/);
  // The option switched off while the fresh read runs.
  fake.behaviors.push({ path: '/spc/area/1', delay: 500, times: 1 });
  const pending = pressFor('1', 'disarm');
  app.config = { ...app.config, allowDisarm: false };
  const answer = await pending;
  assert.match(answer.error, /disabled/);
  assert.equal(puts(fake).length, 0);
});

test('a set withdraws the unset of its area still waiting; an older unset never goes after it', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  const { press, wait } = await setup({ fake, config: ALLOW });
  // The fresh read of the unset is slow; the set is pressed meanwhile.
  fake.behaviors.push({ path: '/spc/area/1', delay: 1500, times: 1 });
  const unset = press('1', 'disarm');
  await wait(200);
  const set = press('1', 'arm-full');
  await wait(5 * SECOND);
  assert.match((await unset).error, /^Withdrawn: a set command of this area was asked after it/);
  assert.equal((await set).success, true);
  assert.deepEqual(
    puts(fake).map((p) => p.split('@')[0]),
    ['set'],
    'the set sent (it lowers nothing), the unset never left',
  );
  assert.equal(fake.areas.get('1').mode, '3');
});

test('a set while an unset of Gladys is in flight: sent again once the unset landed after it', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  const { press, wait, logs } = await setup({ fake, config: ALLOW });
  // The unset PUT is answered (and applied) 2 s after it left.
  fake.behaviors.push({ method: 'PUT', path: '/spc/area/1/unset', delay: 2000, times: 1 });
  const unset = press('1', 'disarm');
  await wait(300);
  const set = press('1', 'arm-full');
  await wait(400);
  // The set reached the panel first (it was still set), then the unset applied.
  await wait(10 * SECOND);
  await unset;
  await set;
  assert.ok(puts(fake).filter((p) => p.startsWith('set@')).length >= 2, `${puts(fake)} ${logs}`);
  assert.equal(fake.areas.get('1').mode, '3', 'the protective command wins');
});

test('an unset asked after a set lifts its guard once it left; still writes while a set may apply', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait, store, app } = await setup({ fake, config: ALLOW });
  fake.applyDelay = 30 * SECOND;
  await pressFor('1', 'arm-full');
  assert.equal(app.guards.size, 1);
  // The area still reads unset, but the set may apply: the unset is written.
  const answer = await pressFor('1', 'disarm');
  assert.ok(
    puts(fake).some((p) => p.startsWith('unset@')),
    `${JSON.stringify(answer)}`,
  );
  await wait(0);
  assert.equal(store.data.guards.length, 0);
  await wait(5 * MINUTE);
  assert.equal(puts(fake).filter((p) => p.startsWith('set@')).length, 1, 'never sent again');
});

test('unset: at most 6 per area per minute; sets are never limited', async () => {
  const fake = createFakeGateway();
  const { pressFor } = await setup({ fake, config: ALLOW });
  for (let i = 0; i < 6; i += 1) {
    fake.setMode('1', '3');
    assert.equal((await pressFor('1', 'disarm')).success, true);
  }
  fake.setMode('1', '3');
  const seventh = await pressFor('1', 'disarm');
  assert.match(seventh.error, /at most 6 unset commands/);
  for (let i = 0; i < 8; i += 1) {
    fake.setMode('3', '0');
    assert.equal((await pressFor('3', 'arm-full')).success, true);
  }
});

test('a set cuts a read silent for 1 s', async () => {
  const fake = createFakeGateway();
  const { press, wait, logs } = await setup({ fake });
  fake.behaviors.push({ path: '/spc/zone', action: 'hang', times: 1 });
  await wait(MINUTE + 2 * SECOND);
  const answer = press('1', 'arm-full');
  await wait(5 * SECOND);
  assert.equal((await answer).success, true);
  assert.ok(logs.some((l) => /1 silent read\(s\) cut/.test(l)));
});

test('the gateway answers HTTP 400: one request, the exact reason, never sent again', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait } = await setup({ fake });
  fake.behaviors.push({ method: 'PUT', action: 'status', status: 400 });
  const answer = await pressFor('1', 'arm-full');
  assert.match(answer.error, /refused by the gateway \(HTTP 400\)/);
  await wait(5 * MINUTE);
  assert.equal(puts(fake).length, 1);
});

test('the gateway answers HTTP 500: two requests at most, then "no valid answer"', async () => {
  const fake = createFakeGateway();
  const { pressFor } = await setup({ fake });
  fake.behaviors.push({ method: 'PUT', action: 'status', status: 500 });
  const answer = await pressFor('1', 'arm-full');
  assert.match(answer.error, /no valid answer from the gateway \(HTTP error 500\)/);
  assert.equal(puts(fake).length, 2);
});

test('"failed" on an area already fully set: success', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  const { pressFor } = await setup({ fake });
  fake.refuseCommands = true;
  assert.deepEqual(await pressFor('1', 'arm-full'), { success: true });
});

test('an unset decided but not yet connected is cut by a set pressed meanwhile', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  const { press, wait } = await setup({ fake, config: ALLOW });
  // The connection of the unset takes 1 s (a SYN refused once by a busy gateway).
  fake.behaviors.push({ method: 'PUT', path: '/spc/area/1/unset', connectDelay: 1000, times: 1 });
  const unset = press('1', 'disarm');
  await wait(300);
  const set = press('1', 'arm-full');
  await wait(10 * SECOND);
  assert.match((await unset).error, /^Withdrawn: a set command of this area was asked after it/);
  assert.equal((await set).success, true);
  assert.equal(fake.requests.filter((r) => r.path.endsWith('/unset') && r.sent).length, 0);
  await wait(MINUTE);
  assert.equal(fake.areas.get('1').mode, '3');
});

test('a refusal of the credentials kept never blocks a set: one try per press, a success lifts it', async () => {
  const fake = createFakeGateway({ auth: { scheme: 'digest', username: 'u', password: 'p' } });
  const store = memoryStore();
  const first = await setup({ fake, store, config: { username: 'u', password: 'p' } });
  fake.auth.password = 'other';
  await first.wait(MINUTE);
  assert.ok(store.data.refused);
  // The gateway takes the password again: a press goes, and lifts the refusal.
  fake.auth.password = 'p';
  fake.requests.length = 0;
  const again = await setup({
    fake,
    store,
    now: T0 + 10 * MINUTE,
    config: { username: 'u', password: 'p' },
  });
  assert.equal(fake.requests.length, 0, 'no read by itself');
  assert.deepEqual(await again.pressFor('1', 'arm-full'), { success: true });
  assert.equal(store.data.refused, null);
  await again.wait(MINUTE);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  // Still refused: one try (the challenge and the answer), the true reason.
  fake.auth.password = 'changed';
  fake.requests.length = 0;
  const refused = await again.pressFor('3', 'arm-full');
  assert.match(refused.error, /refuses the user name or the password/);
  assert.ok(fake.count('PUT', /set$/) <= 2);
});

test('a set before the configuration of Gladys is read: the true reason', async () => {
  const { app } = await setup({ connect: false });
  await assert.rejects(app.arm('1', 'full_set', 0), /configuration of Gladys is not read yet/);
});

test('the panel refuses a set (a zone open): said, never sent again', async () => {
  const fake = createFakeGateway();
  const { pressFor, wait, store } = await setup({ fake });
  fake.refuseCommands = true;
  const answer = await pressFor('1', 'arm-full');
  assert.match(answer.error, /refused by the panel/);
  await wait(5 * MINUTE);
  assert.equal(puts(fake).length, 1);
  assert.equal(store.data.guards.length, 0);
});

test('after a restart: a set that never left is sent only if the area is as at the press', async () => {
  const ref = { mode: 'unset', lastSetTime: 1485759851, lastUnsetTime: 1485800564 };
  const store = memoryStore({
    panel: SERIAL,
    lastAttemptAt: T0 - 2 * MINUTE,
    guards: [
      { area: '1', mode: 'full_set', at: T0 - 30 * SECOND, resends: 0, delivered: false, ref },
      // Accepted by the gateway before the restart: never sent again.
      { area: '3', mode: 'full_set', at: T0 - 20 * SECOND, resends: 0, delivered: true, ref },
    ],
  });
  const fake = createFakeGateway();
  await setup({ fake, store });
  assert.deepEqual(
    puts(fake).map((p) => p.split('@')[0]),
    ['set'],
  );
  assert.equal(fake.areas.get('1').mode, '3');
  assert.equal(fake.areas.get('3').mode, '0');
  // The area unset at the keypad while the container restarted: not sent.
  const moved = memoryStore({
    panel: SERIAL,
    guards: [{ area: '1', mode: 'full_set', at: T0 - 30 * SECOND, resends: 0, ref }],
  });
  const other = createFakeGateway();
  other.areas.get('1').last_unset_time = '1485800999';
  const again = await setup({ fake: other, store: moved });
  await again.wait(5 * MINUTE);
  assert.equal(puts(other).length, 0);
  // Older than 2 minutes: dropped.
  const old = memoryStore({
    panel: SERIAL,
    guards: [{ area: '1', mode: 'full_set', at: T0 - 3 * MINUTE, resends: 0, ref }],
  });
  const third = createFakeGateway();
  await setup({ fake: third, store: old });
  assert.equal(puts(third).length, 0);
});

test('a scene sets 5 areas with a slow gateway (800 ms per answer): all 5 set in time', async () => {
  const areas = ['1', '2', '3', '4', '5'].map((id) => ({
    id,
    name: `A${id}`,
    mode: '0',
    last_set_time: '1',
    last_unset_time: '2',
  }));
  const fake = createFakeGateway({ areas, zones: [] });
  const { press, wait } = await setup({ fake });
  fake.latency = 800;
  const answers = areas.map((a) => press(a.id, 'arm-full'));
  await wait(5 * SECOND);
  const results = await Promise.all(answers);
  assert.deepEqual(
    results.map((r) => r.success),
    [true, true, true, true, true],
  );
  for (const a of areas) assert.equal(fake.areas.get(a.id).mode, '3');
});

test('buttons only: a value other than 1 and the read-only features are refused', async () => {
  const fake = createFakeGateway();
  const { gladys } = await setup({ fake });
  const area = device(gladys.fake.devices, 'area', '1');
  const zero = await gladys.fake.setValue(area, feature(area, 'arm-full'), 0);
  assert.match(zero.error, /a button takes 1 only/);
  const mode = await gladys.fake.setValue(area, feature(area, 'armed'), 1);
  assert.match(mode.error, /read-only/);
  assert.equal(puts(fake).length, 0);
});

test('unset: the serial read again with the area; another panel meanwhile refuses it', async () => {
  const fake = createFakeGateway();
  fake.setMode('1', '3');
  const { pressFor } = await setup({ fake, config: ALLOW });
  fake.panel.sn = 'CAFEF00D';
  const answer = await pressFor('1', 'disarm');
  assert.match(answer.error, /another panel answers: unsetting refused, nothing sent/);
  assert.equal(puts(fake).length, 0);
});
