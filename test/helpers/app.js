// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, the fake gateway and a virtual
// clock, through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SpcApp } from '../../src/app.js';
import { normalizeConfig } from '../../src/config.js';
import { buildDevices } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { parseArea, parseList, parseZone } from '../../src/spc/parse.js';
import { memoryStore } from '../../src/store.js';
import { createFakeClock } from './fakeClock.js';
import { createFakeGateway } from './fakeGateway.js';

export const SELECTOR = 'vanderbilt-spc';
export const T0 = Date.parse('2026-10-26T08:00:00Z');
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const BASE_CONFIG = { host: '192.168.1.10' };

const ids = createFakeGladys({ selector: SELECTOR });

/** The devices Discovery gives for the fake gateway (as created by the user). */
export function createdDevices(fake = createFakeGateway(), config = BASE_CONFIG) {
  const model = {
    panel: { type: 'SPC4000' },
    areas: parseList([...fake.areas.values()], parseArea, 64).byId,
    zones: parseList([...fake.zones.values()], parseZone, 1024).byId,
  };
  return buildDevices(ids, normalizeConfig(config), model, []);
}

export const device = (devices, kind, id) =>
  devices.find((d) => d.external_id.endsWith(kind === 'panel' ? ':panel:spc' : `:${kind}:${id}`));
export const feature = (dev, key) => dev.features.find((f) => f.external_id.endsWith(`:${key}`));
export const featureId = (kind, id, key) =>
  kind === 'panel'
    ? ids.externalIds('panel', 'spc').feature(key)
    : ids.externalIds(kind, id).feature(key);

const tick = () => new Promise((resolve) => setImmediate(resolve));
export const settle = async () => {
  for (let i = 0; i < 30; i += 1) await tick();
};

export async function setup({
  config = {},
  fake = createFakeGateway(),
  created,
  store = memoryStore(),
  now = T0,
  connect = true,
} = {}) {
  const devices = created ?? createdDevices(fake, { ...BASE_CONFIG, ...config });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices,
  });
  const { clock, timers, advance, pending } = createFakeClock(now);
  fake.timers = timers;
  fake.clock = clock;
  let drift = 0;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  const app = new SpcApp({
    gladys,
    logger,
    request: fake.request,
    socketFactory: fake.socketFactory,
    now: () => clock.now,
    // A real monotonic clock moves between two reads of it: 1 µs per call
    // here, so that a decision reading the clock twice is caught.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
    random: (n) => Buffer.alloc(n, 7),
  });
  registerHandlers(gladys, app, logger);
  if (connect) {
    await gladys.connect();
    await settle();
    await advance(0);
    await settle();
  }
  const wait = async (ms) => {
    await advance(ms);
    await settle();
  };
  /** Presses a button of an area; resolves { ok, error } once Gladys has its answer. */
  const press = (areaId, key) => {
    const dev = device(gladys.fake.devices, 'area', areaId);
    return gladys.fake.setValue(dev, feature(dev, key), 1);
  };
  /** Presses while the clock runs: the answer, and the clock moved by `ms`. */
  const pressFor = async (areaId, key, ms = 5 * SECOND) => {
    const answer = press(areaId, key);
    let result;
    answer.then((r) => {
      result = r;
    });
    await settle();
    for (let t = 0; t < ms && result === undefined; t += 50) await wait(50);
    await settle();
    return result ?? (await answer);
  };
  return { app, gladys, fake, clock, timers, pending, advance, wait, logs, store, press, pressFor };
}
