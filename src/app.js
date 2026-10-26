// -----------------------------------------------------------------------------
// SpcApp: the integration. One Vanderbilt SPC panel through its SPC Web
// Gateway (Lundix): REST reads, websocket events, area commands.
//
//   start(config)  (re)connects: the client is built at once (setting an area
//                  works from the start), /data is read, the reading loop
//                  armed. The same configuration again (Gladys reconnected)
//                  only publishes again what is fresh.
//   reading loop   every 60 s: the areas (the main resource), the panel
//                  serial (the identity), the zones. Failures: the
//                  next try 30 s to 5 min later, never sooner than 60 s.
//   websocket      SIA events: the area or zone they name is read at once
//                  (at most one read per 250 ms, a burst reads everything).
//   commands       buttons of each area: full set, part set A, part set B
//                  (protective, never behind a read, a pause or an option),
//                  unset (off by default, decided on a fresh read).
//
// Two clocks: `now` (wall clock) dates what /data keeps; `monotonic` paces
// the reads, the commands, the guards and the freshness. One read of the
// clock per decision: dueAt(mono) computes on the caller's instant.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { configKey, normalizeConfig } from './config.js';
import { ARM_BUTTONS, LIMITS, SIA, TIMINGS } from './constants.js';
import { buildDevices, buildStates, ids, parseFeatureId } from './devices.js';
import { MODE_NAMES, T } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { CODES, isAuthError } from './spc/errors.js';
import { GatewayClient } from './spc/client.js';
import { EventSocket, defaultSocketFactory } from './spc/events.js';
import { parseEvent } from './spc/parse.js';
import { fileStore, normalizeMemory, refusalOf, sameRefused, serializeMemory } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const MINUTE = 60_000;

/** An area shows an arm: the same mode, or a full set (it covers a part set). */
export const shows = (area, mode) =>
  area?.mode === mode || (mode !== 'unset' && area?.mode === 'full_set');

/** A refusal: nothing was sent to the gateway. */
class Refused extends Error {}

export class SpcApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake gateway)
   * @param {Function} [options.socketFactory] the websocket factory (tests inject one)
   * @param {() => number} [options.now] wall clock (ms)
   * @param {() => number} [options.monotonic] monotonic clock (ms)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {{ load: Function, save: Function }} [options.store] /data
   * @param {(size: number) => Buffer} [options.random]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'vanderbilt-spc' }),
    request,
    socketFactory = defaultSocketFactory,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = fileStore(),
    random,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.socketFactory = socketFactory;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.random = random;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.key = null;
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.running = false;
    this.queue = Promise.resolve();
    this.timer = undefined;
    this.configTimer = undefined;
    this.lastStatus = null;
    /** What /data keeps (loaded once, kept across configurations). */
    this.memory = undefined;
    this.dataError = false;
    this.saveWarned = false;
    this.attemptSavedAt = 0;
    /** Arms not yet seen applied, by area: see "Guards". */
    this.guards = new Map();
    /** Areas whose arm is being sent (by a press or a guard). */
    this.resending = new Set();
    /** The last "Test the connection" read (monotonic). */
    this.lastForcedAt = undefined;
    this.reset();
  }

  /** Everything that belongs to one session (one configuration). */
  reset() {
    this.online = false;
    this.model = { panel: null, areas: new Map(), zones: new Map(), verified: new Set() };
    this.readAt = undefined;
    this.zonesUnread = false;
    /** The identity of the panel in this session: unknown, ok or other. */
    this.identity = 'unknown';
    this.seenSerial = null;
    /** Reads are numbered: an older answer never overwrites a newer one. */
    this.readSeq = 0;
    this.lastReadAt = undefined;
    this.nextTryAt = undefined;
    this.retryDelay = TIMINGS.retryMin;
    this.busy = undefined;
    /** A stop on credentials: { kind: 'required' | 'refused' | 'unsupported' } | null. */
    this.authStop = null;
    /** The gateway refused a command with these credentials (this session only). */
    this.commandAuthRefused = false;
    this.discoveredKey = null;
    this.transports = new Map();
    // Websocket.
    this.events = null;
    this.eventsState = 'down';
    this.wsTimer = undefined;
    this.pingTimer = undefined;
    this.wsRetry = 0;
    this.wsWindow = { start: 0, count: 0 };
    this.dirty = new Set();
    this.dirtyAll = false;
    this.eventTimer = undefined;
    this.eventBusy = false;
    this.lastEventReadAt = undefined;
    // Commands.
    this.armLines = new Map();
    this.disarmLines = new Map();
    this.disarmTickets = new Set();
    /** Disarms written and not answered yet, by area (count). */
    this.disarmsInFlight = new Map();
    /** When the last disarm of an area was answered (monotonic). */
    this.disarmSettledAt = new Map();
    /** Disarms written in the last minute, by area (monotonic). */
    this.disarmWrites = new Map();
    this.readBacks = new Set();
  }

  // --- Lifecycle -------------------------------------------------------------

  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /** (Re)start with a configuration. `force`: the user pressed "Test the connection". */
  start(raw, { force = false } = {}) {
    return this.enqueue(() => this.run(raw, { force }));
  }

  connected(raw) {
    this.clearConfigTimer();
    return this.start(raw);
  }

  /** A saved configuration: a new session when it changed; it lifts no refusal by itself. */
  configUpdated(raw) {
    return this.start(raw);
  }

  /**
   * The configuration read from Gladys, then start. When Gladys does not give
   * it, asked again 30 s, 1 min, 2 min... 10 min at most, without end.
   */
  async startFromGladys(attempt = 0) {
    this.clearConfigTimer();
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      const delay = clamp(
        TIMINGS.configRetryMin * 2 ** attempt,
        TIMINGS.configRetryMin,
        TIMINGS.configRetryMax,
      );
      this.logger.warn(`Configuration not read (${err?.status ?? 'error'}): asked again`);
      await this.setStatus(false, T.status.configNotRead(delay));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.startFromGladys(attempt + 1).catch((e) =>
          this.logger.error(`Start failed (${e?.name ?? 'Error'})`),
        );
      }, delay);
      return;
    }
    await this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    this.halt();
    this.dropSession();
    this.publisher.stop();
    if (this.memory) await this.save();
  }

  /** Clear the timers of the session; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    this.clearConfigTimer();
    for (const name of ['timer', 'wsTimer', 'pingTimer', 'eventTimer']) {
      if (this[name] !== undefined) {
        this.timers.clearTimeout(this[name]);
        this[name] = undefined;
      }
    }
    for (const timer of this.readBacks) this.timers.clearTimeout(timer);
    this.readBacks.clear();
    for (const guard of this.guards.values()) this.clearFollow(guard);
  }

  dropSession() {
    this.client?.close();
    this.client = null;
    this.events?.close();
    this.events = null;
  }

  async loadMemory() {
    if (this.memory) return true;
    let raw;
    try {
      raw = await this.store.load();
    } catch (err) {
      if (!this.dataError) this.logger.warn(`/data not readable (${err?.code ?? 'error'})`);
      this.dataError = true;
      return false;
    }
    this.dataError = false;
    const now = this.now();
    const mono = this.monotonic();
    const memory = normalizeMemory(raw, now);
    // Arms asked since the start (before /data was read) win over the kept ones.
    for (const [area, kept] of memory.guards) {
      if (this.guards.has(area)) continue;
      this.guards.set(area, {
        ...kept,
        atMono: mono - (now - kept.at),
        followIndex: TIMINGS.followUps.length,
        restart: true,
        followTimer: undefined,
      });
    }
    this.memory = memory;
    if (memory.lastAttemptAt > 0) {
      const age = Math.max(0, now - memory.lastAttemptAt);
      if (age < TIMINGS.poll) this.lastReadAt = mono - age;
    }
    this.attemptSavedAt = memory.lastAttemptAt;
    if (raw === null || this.guards.size > 0) await this.save();
    return true;
  }

  async save() {
    if (!this.memory) return;
    this.memory.guards = new Map(
      [...this.guards.values()].map((g) => [
        g.area,
        {
          area: g.area,
          mode: g.mode,
          at: g.at,
          resends: g.resends,
          delivered: g.delivered,
          setTime: g.setTime,
          overlap: g.overlap,
        },
      ]),
    );
    try {
      await this.store.save(serializeMemory(this.memory));
      this.saveWarned = false;
    } catch (err) {
      if (!this.saveWarned) this.logger.warn(`/data not written: ${err?.code ?? err?.message}`);
      this.saveWarned = true;
    }
  }

  async run(raw, { force = false }) {
    const config = normalizeConfig(raw);
    const key = configKey(config);
    if (this.client && key === this.key && this.running) {
      if (force) this.lift();
      await this.resume();
      return;
    }
    const sameGateway =
      config.gateway !== null && config.gateway.origin === this.config.gateway?.origin;
    this.halt();
    this.dropSession();
    this.publisher.stop();
    this.generation += 1;
    this.running = true;
    this.config = config;
    this.key = key;
    this.reset();
    this.lastStatus = null;
    this.gladys.forgetPublishedStates?.();
    this.publisher.forget();
    if (!sameGateway && this.guards.size > 0) {
      // Another gateway: the arms asked of the old one are not sent to it.
      this.guards.clear();
      if (this.memory) await this.save();
    }
    const problem = this.configProblem(config);
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    this.client = new GatewayClient({
      origin: config.gateway.origin,
      credentials: config.credentials,
      request: this.request,
      monotonic: this.monotonic,
      random: this.random,
    });
    this.logger.info(
      `Using the gateway at ${config.gateway.origin}${config.credentials ? ' (with credentials)' : ''}`,
    );
    await this.setStatus(false, T.status.connecting);
    await this.connect({ force });
  }

  /** /data, then the loop; /data unreadable: tried again every minute (the arms work meanwhile). */
  async connect({ force }) {
    if (!(await this.loadMemory())) {
      await this.setStatus(false, T.status.dataUnreadable);
      const epoch = this.epoch;
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined;
        if (epoch !== this.epoch || !this.running) return;
        return this.enqueue(() => this.connect({ force })).catch((err) =>
          this.logger.error(`Start failed (${err?.name ?? 'Error'})`),
        );
      }, TIMINGS.dataRetry);
      return;
    }
    // A refusal kept for these very credentials: no try until the user acts.
    const refused = this.memory.refused;
    if (refused && sameRefused(refused, this.config.credentials) && !force) {
      this.authStop = { kind: 'refused' };
      await this.setStatus(false, T.status.authRefused);
      await this.publishOffline();
      return;
    }
    if (refused && !sameRefused(refused, this.config.credentials)) {
      // Other credentials (or none): the refusal does not apply to them.
      this.memory.refused = null;
      await this.save();
    }
    if (force) this.lift();
    this.schedule();
  }

  /** The user pressed "Test the connection": one try despite a stop on credentials. */
  lift() {
    const mono = this.monotonic();
    if (this.lastForcedAt !== undefined && mono - this.lastForcedAt < TIMINGS.testGap) return;
    this.lastForcedAt = mono;
    this.authStop = null;
    this.commandAuthRefused = false;
    this.nextTryAt = undefined;
    this.retryDelay = TIMINGS.retryMin;
  }

  configProblem(config) {
    if (config.hostError) {
      return (
        {
          empty: T.status.hostEmpty,
          credentials: T.status.hostCredentials,
          https: T.status.hostHttps,
        }[config.hostError] ?? T.status.hostInvalid
      );
    }
    if (config.credentialsError) return T.status.credentials(config.credentialsError);
    return null;
  }

  /**
   * Gladys reconnected with the same configuration, or the button: status,
   * Discovery, badges and the FRESH states are published again (Gladys may
   * have lost them); nothing is read sooner than the pace.
   */
  async resume() {
    const status = this.lastStatus ? JSON.parse(this.lastStatus) : null;
    this.lastStatus = null;
    this.transports.clear();
    this.discoveredKey = null;
    this.gladys.forgetPublishedStates?.();
    this.publisher.forget();
    if (status) await this.setStatus(status[0], status[1]);
    await this.publishDiscovered();
    await this.publishStates();
    await this.publishTransports();
    if (this.memory && !this.authStop) this.schedule();
  }

  // --- Pace ------------------------------------------------------------------

  /** The monotonic time from which the next read may start, from the caller's instant `mono`. */
  dueAt(mono) {
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + TIMINGS.poll;
    if (this.nextTryAt !== undefined) due = Math.max(due, this.nextTryAt);
    return due;
  }

  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running || !this.client || !this.memory || this.authStop) return;
    const epoch = this.epoch;
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    this.timer = this.timers.setTimeout(async () => {
      this.timer = undefined;
      try {
        await this.tick();
      } catch (err) {
        this.logger.error(`Unexpected error (${err?.name ?? 'Error'})`);
      }
      if (epoch === this.epoch && this.running) this.schedule();
    }, wait);
  }

  /** One read when it is due; a read running is never doubled. */
  tick() {
    if (this.busy) return this.busy;
    this.busy = this.read().finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  /** One round: the areas (main), the panel serial when due, the zones. */
  async read() {
    const client = this.client;
    if (!client || !this.running || !this.memory || this.authStop) return;
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) return;
    const gone = () => client !== this.client || !this.running;
    this.lastReadAt = mono;
    // The time of the attempt, in /data BEFORE the read (at most once a minute).
    const now = this.now();
    this.memory.lastAttemptAt = now;
    if (now - this.attemptSavedAt >= TIMINGS.attemptWrite || now < this.attemptSavedAt) {
      this.attemptSavedAt = now;
      await this.save();
      if (gone()) return;
    }
    const seq = ++this.readSeq;
    let areas;
    try {
      areas = await client.readAreas();
    } catch (err) {
      if (gone()) return;
      await this.failed(err, mono);
      return;
    }
    if (gone()) return;
    // The identity at every read (a DHCP swap shows within a minute). A
    // failure here (a 401 of a secondary page included) changes nothing.
    const panel = await client.readPanel().catch((err) => {
      this.logger.debug(`Panel not read: ${err?.code ?? 'error'}`);
      return undefined;
    });
    if (gone()) return;
    const zones = await client.readZones().catch((err) => {
      this.logger.warn(`Zones not read: ${err?.code ?? 'error'}`);
      return undefined;
    });
    if (gone()) return;
    await this.succeeded({ areas, panel, zones, seq });
  }

  /** A read failed: a stop on credentials, or a retry with a growing delay. */
  async failed(err, mono) {
    const wasOnline = this.online;
    this.online = false;
    if (isAuthError(err)) {
      await this.authFailed(err);
      return;
    }
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, TIMINGS.retryMax);
    this.nextTryAt = mono + delay;
    if (wasOnline || delay === TIMINGS.retryMin) {
      this.logger.warn(
        `The gateway fails: ${err?.code ?? 'error'}${err?.status ? ` ${err.status}` : ''}`,
      );
    }
    await this.publishOffline();
    const notGateway =
      err?.code === CODES.BAD_ANSWER || err?.code === CODES.TOO_LARGE || err?.status === 404;
    await this.setStatus(
      false,
      notGateway
        ? T.status.notGateway(Math.max(delay, TIMINGS.poll))
        : T.status.unreachable(err, Math.max(delay, TIMINGS.poll)),
    );
  }

  /** The main resource refused the credentials (or asks for some): stop until the user acts. */
  async authFailed(err) {
    const kind =
      err.code === CODES.AUTH_REFUSED
        ? 'refused'
        : err.code === CODES.AUTH_UNSUPPORTED
          ? 'unsupported'
          : 'required';
    this.authStop = { kind };
    this.online = false;
    this.events?.close();
    this.events = null;
    this.eventsState = 'down';
    if (kind === 'refused' && this.memory) {
      this.memory.refused = refusalOf(this.config.credentials, this.now(), this.random);
      await this.save();
    }
    this.logger.warn(
      `The gateway ${kind === 'refused' ? 'refuses the credentials' : 'asks for an authentication'}: no new try until the user acts`,
    );
    await this.publishOffline();
    await this.setStatus(
      false,
      { refused: T.status.authRefused, unsupported: T.status.authUnsupported }[kind] ??
        T.status.authRequired,
    );
  }

  async succeeded({ areas, panel, zones, seq }) {
    this.retryDelay = TIMINGS.retryMin;
    this.nextTryAt = undefined;
    if (this.memory.refused) {
      // The credentials work: the refusal kept is no longer true.
      this.memory.refused = null;
      await this.save();
    }
    if (areas.dropped > 0) this.logger.warn(`${areas.dropped} area(s) not understood, ignored`);
    if (panel) {
      this.model.panel = panel;
      if (panel.serial === null) {
        // Unreadable: nothing is learnt nor dropped.
      } else if (this.memory.panel === null) {
        this.memory.panel = panel.serial;
        this.identity = 'ok';
        this.logger.info(`Panel ${panel.serial} learnt`);
        await this.save();
      } else if (this.memory.panel === panel.serial) {
        this.identity = 'ok';
      } else {
        if (this.identity !== 'other' || this.seenSerial !== panel.serial) {
          this.logger.warn(`Another panel answers: ${panel.serial} (kept: ${this.memory.panel})`);
        }
        this.identity = 'other';
        this.seenSerial = panel.serial;
      }
    }
    this.online = true;
    if (this.identity === 'other') {
      await this.publishOffline();
      await this.setStatus(false, T.status.otherPanel(this.seenSerial));
      return;
    }
    this.applyAreas(areas.byId, seq, { replace: true });
    if (zones) {
      if (zones.dropped > 0) this.logger.warn(`${zones.dropped} zone(s) not understood, ignored`);
      this.applyZones(zones.byId, seq, { replace: true });
    }
    this.zonesUnread = !zones;
    this.readAt = this.monotonic();
    this.checkGuards();
    await this.publishDiscovered();
    await this.publishStates();
    await this.publishTransports();
    await this.refreshStatus();
    this.ensureEvents();
  }

  /** Areas read: newer than what the model holds only (by read number). */
  applyAreas(byId, seq, { replace = false } = {}) {
    const next = replace ? new Map() : this.model.areas;
    for (const [id, area] of byId) {
      const known = this.model.areas.get(id);
      next.set(id, known && known.seq > seq ? known : { ...area, seq });
    }
    this.model.areas = next;
    for (const id of this.model.verified) {
      const area = next.get(id);
      if (!area || area.mode === 'unset') this.model.verified.delete(id);
    }
  }

  applyZones(byId, seq, { replace = false } = {}) {
    const next = replace ? new Map() : this.model.zones;
    for (const [id, zone] of byId) {
      const known = this.model.zones.get(id);
      next.set(id, known && known.seq > seq ? known : { ...zone, seq });
    }
    this.model.zones = next;
  }

  /** An area read for a command or an event: kept when newer; the fresh states published in the background. */
  observeArea(area, seq) {
    if (this.identity === 'other' || !this.model.areas.has(area.id)) return;
    this.applyAreas(new Map([[area.id, area]]), seq);
    void this.publishStates();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err?.message}`);
    });
  }

  async refreshStatus() {
    if (!this.online || this.identity === 'other' || this.authStop) return;
    const zones = [...this.model.zones.values()].filter((z) => z.type !== '12').length;
    await this.setStatus(
      true,
      T.status.ok({
        areas: this.model.areas.size,
        zones,
        events: this.eventsState,
        zonesUnread: this.zonesUnread,
        identityUnread: this.identity !== 'ok',
        zoneKindsInvalid: this.config.zoneKindsInvalid,
        unwritable: this.saveWarned,
      }),
    );
  }

  // --- Publishing ------------------------------------------------------------

  /** The devices of what was read; never a read. Never throws. */
  async publishDiscovered() {
    if (!this.client || this.identity === 'other') return;
    const devices = buildDevices(this.gladys, this.config, this.model);
    const key = JSON.stringify(
      devices.map((d) => [d.external_id, d.name, d.features.map((f) => f.external_id)]),
    );
    if (key === this.discoveredKey) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveredKey = key;
    } catch (err) {
      this.logger.warn(`Discovery not published: ${err?.message}`);
    }
  }

  /** Discovery (scan button): what is known; never a read sooner than the pace. */
  async scan() {
    this.discoveredKey = null;
    await this.publishDiscovered();
  }

  /** States of a model read lately only (never an old value published as new). */
  states() {
    const mono = this.monotonic();
    const fresh =
      this.online &&
      this.identity !== 'other' &&
      this.readAt !== undefined &&
      mono - this.readAt <= TIMINGS.fresh;
    return buildStates(this.gladys, this.config, this.model, { online: fresh });
  }

  publishStates() {
    return this.publisher.publish(this.states());
  }

  async publishOffline() {
    await this.publisher.publish(
      buildStates(this.gladys, this.config, this.model, { online: false }),
    );
    await this.publishTransports();
  }

  async publishTransports() {
    const prefix = ids.panel(this.gladys).device.replace(/panel:spc$/, '');
    const reachable = this.online && this.identity !== 'other' && !this.authStop;
    const entries = (this.gladys.devices ?? [])
      .filter((d) => String(d?.external_id ?? '').startsWith(prefix))
      .map((d) => ({ external_id: d.external_id, transport: reachable ? 'local' : 'unreachable' }));
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    for (let start = 0; start < changed.length; start += LIMITS.transportsPerCall) {
      const batch = changed.slice(start, start + LIMITS.transportsPerCall);
      for (const e of batch) this.transports.set(e.external_id, e.transport);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const e of batch) this.transports.delete(e.external_id);
        this.logger.debug(`Transports not published: ${err?.message}`);
      });
    }
  }

  async deviceChanged(device) {
    this.transports.delete(device?.external_id);
    this.publisher.forget(device?.external_id);
    await this.publishStates();
    await this.publishTransports();
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Websocket -------------------------------------------------------------

  /** Opens the websocket when the session is up and none is open or planned. */
  ensureEvents() {
    if (!this.running || !this.client || !this.online || this.authStop) return;
    if (this.events || this.wsTimer !== undefined || this.eventsState === 'refused') return;
    void this.openEvents();
  }

  async openEvents() {
    const client = this.client;
    const generation = this.generation;
    const socket = new EventSocket({
      host: this.config.gateway.host,
      client,
      factory: this.socketFactory,
      onMessage: (text) => this.onEvent(text, socket),
      onClose: () => this.eventsClosed(socket),
    });
    this.events = socket;
    try {
      await socket.open();
    } catch (err) {
      if (this.events !== socket || generation !== this.generation) return;
      this.events = null;
      if (String(err?.kind).startsWith('auth')) {
        // The REST API works with these credentials: only the events are refused.
        this.logger.warn(`Websocket refused (${err.kind}): reads every minute only`);
        this.eventsState = 'refused';
        await this.refreshStatus();
        return;
      }
      this.logger.debug(`Websocket not opened (${err?.kind ?? 'error'} ${err?.status ?? ''})`);
      this.retryEvents();
      return;
    }
    if (this.events !== socket || generation !== this.generation || !this.running) {
      socket.close();
      return;
    }
    this.wsRetry = 0;
    this.eventsState = 'live';
    this.logger.info('Websocket open: live events');
    this.startPing(socket);
    await this.refreshStatus();
  }

  retryEvents() {
    if (!this.running || this.wsTimer !== undefined) return;
    const delay = TIMINGS.wsRetry[Math.min(this.wsRetry, TIMINGS.wsRetry.length - 1)];
    this.wsRetry += 1;
    const epoch = this.epoch;
    this.wsTimer = this.timers.setTimeout(() => {
      this.wsTimer = undefined;
      if (epoch === this.epoch) this.ensureEvents();
    }, delay);
  }

  startPing(socket) {
    const epoch = this.epoch;
    const beat = () => {
      this.pingTimer = this.timers.setTimeout(() => {
        this.pingTimer = undefined;
        if (epoch !== this.epoch || this.events !== socket) return;
        if (!socket.ping()) {
          this.logger.warn('Websocket silent (no pong): closed');
          socket.kill();
          return;
        }
        beat();
      }, TIMINGS.wsPing);
    };
    beat();
  }

  async eventsClosed(socket) {
    if (this.events !== socket) return;
    this.events = null;
    if (this.pingTimer !== undefined) {
      this.timers.clearTimeout(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.eventsState = 'down';
    this.logger.info('Websocket closed: reads every minute until it opens again');
    await this.refreshStatus();
    this.retryEvents();
  }

  /** A websocket message: the area or zone it names is read (bounded, linear). */
  onEvent(text, socket) {
    if (this.events !== socket) return;
    const mono = this.monotonic();
    if (mono - this.wsWindow.start >= MINUTE) this.wsWindow = { start: mono, count: 0 };
    this.wsWindow.count += 1;
    if (this.wsWindow.count > LIMITS.wsMessagesPerMinute) {
      this.logger.warn('Websocket flood: closed (the reads go on)');
      socket.kill();
      return;
    }
    const event = parseEvent(text);
    if (!event) return;
    if (SIA.ALL_AREAS.has(event.code)) {
      for (const id of this.model.areas.keys()) this.markDirty('area', id);
    } else if (SIA.AREA.has(event.code) && event.address !== null) {
      if (event.code === SIA.VERIFIED_ALARM && this.model.areas.has(event.address)) {
        this.model.verified.add(event.address);
      }
      this.markDirty('area', event.address);
    } else if (SIA.ZONE.has(event.code) && event.address !== null) {
      this.markDirty('zone', event.address);
    } else {
      return;
    }
    this.scheduleEventRead();
  }

  markDirty(kind, id) {
    const map = kind === 'area' ? this.model.areas : this.model.zones;
    // Only what Discovery knows: a new area or zone comes with the next full read.
    if (!map.has(id)) return;
    if (this.dirty.size >= LIMITS.maxDirty) this.dirtyAll = true;
    else this.dirty.add(`${kind}:${id}`);
  }

  scheduleEventRead() {
    if (this.eventTimer !== undefined || this.eventBusy) return;
    if (this.dirty.size === 0 && !this.dirtyAll) return;
    const mono = this.monotonic();
    const wait =
      this.lastEventReadAt === undefined
        ? 0
        : Math.max(0, this.lastEventReadAt + TIMINGS.eventGap - mono);
    const epoch = this.epoch;
    this.eventTimer = this.timers.setTimeout(() => {
      this.eventTimer = undefined;
      if (epoch !== this.epoch) return;
      this.eventReads().catch((err) =>
        this.logger.error(`Unexpected error (${err?.name ?? 'Error'})`),
      );
    }, wait);
  }

  /** The reads asked by events: everything when there were many, else each one named. */
  async eventReads() {
    const client = this.client;
    if (!client || !this.online || this.authStop || this.identity === 'other') {
      this.dirty.clear();
      this.dirtyAll = false;
      return;
    }
    this.eventBusy = true;
    this.lastEventReadAt = this.monotonic();
    const all = this.dirtyAll;
    const names = [...this.dirty];
    this.dirty.clear();
    this.dirtyAll = false;
    const gone = () => client !== this.client || !this.running;
    try {
      if (all) {
        const seq = ++this.readSeq;
        const areas = await client.readAreas();
        if (gone()) return;
        this.applyAreas(areas.byId, seq);
        const zseq = ++this.readSeq;
        const zones = await client.readZones();
        if (gone()) return;
        this.applyZones(zones.byId, zseq);
      } else {
        for (const name of names) {
          const [kind, id] = name.split(':');
          const seq = ++this.readSeq;
          if (kind === 'area') {
            const area = await client.readArea(id);
            if (gone()) return;
            this.applyAreas(new Map([[id, area]]), seq);
          } else {
            const zone = await client.readZone(id);
            if (gone()) return;
            this.applyZones(new Map([[id, zone]]), seq);
          }
        }
      }
    } catch (err) {
      // The next periodic read covers it; a refusal here never stops anything.
      this.logger.debug(`Event read failed: ${err?.code ?? 'error'}`);
    } finally {
      this.eventBusy = false;
    }
    if (gone()) return;
    this.checkGuards();
    await this.publishStates();
    this.scheduleEventRead();
  }

  // --- Commands --------------------------------------------------------------
  //
  // Buttons only (never a switch): full set, part set A, part set B, unset.
  //
  // Setting (arming) is the protective command: it needs no option, no read
  // made before (it works from the start, before the first read), it is not
  // held back by the waits between failed reads, nor by a read running (its
  // own connection; a read silent for 1 s is cut), nor by an unset command
  // waiting: it withdraws the unset commands of its area not written yet.
  // Its request is tried again every 250 ms until 3.5 s after the press; the
  // area is read back until 4.3 s. A set not seen applied keeps a guard: the
  // area is read again 5, 20 and 60 s later, and the set is sent again (3
  // times at most, 10 minutes at most) when the request never reached the
  // gateway, when an unset command of Gladys in flight may have landed after
  // it, or when the area still does not show it at the last of those reads.
  // A guard is lifted when the area shows the mode, when the area was set
  // then unset by someone else (its last set time moved), or by an unset
  // command of Gladys asked after it once that request left.
  //
  // A part set never lowers a full set (nothing sent) nor replaces the other
  // part set (refused): it reads the area first (1.2 s), and when that read
  // fails it is sent only if the last state known is "unset".
  //
  // Unsetting (disarming) is off by default (option, checked when asked and
  // right before the write), needs the identity of the panel read in this
  // session, at most 6 per area per minute, one at a time per area, decided
  // on the area read now (by 2.5 s), written by 3.5 s, confirmed by a read.

  async setValue(_device, feature, value) {
    const received = this.monotonic();
    const target = parseFeatureId(this.gladys, feature?.external_id);
    const isArm = target?.kind === 'area' && Object.hasOwn(ARM_BUTTONS, target.key);
    const isDisarm = target?.kind === 'area' && target.key === 'disarm';
    if (!isArm && !isDisarm) throw new Error(T.errors.readOnly);
    if (value !== 1 && value !== '1') throw new Error(T.errors.badValue);
    if (isDisarm) return this.disarm(target.id, received);
    return this.arm(target.id, ARM_BUTTONS[target.key], received);
  }

  /** What refuses any command before anything is sent. */
  commonChecks() {
    if (!this.client || !this.running) throw new Refused(T.errors.notConfigured);
    if (this.authStop?.kind === 'refused' || this.commandAuthRefused) {
      throw new Refused(T.errors.authRefused);
    }
    if (this.authStop) throw new Refused(T.errors.authRequired);
    if (this.identity === 'other') throw new Refused(T.errors.otherPanel);
  }

  stillSame(client, generation) {
    if (client !== this.client || generation !== this.generation || !this.running) {
      throw new Refused(T.errors.configChanged);
    }
  }

  sleep(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, Math.max(0, ms)));
  }

  /** A disarm of this area written and not answered, or answered less than answerBy ago. */
  disarmUncertain(area, mono) {
    if ((this.disarmsInFlight.get(area) ?? 0) > 0) return true;
    const at = this.disarmSettledAt.get(area);
    return at !== undefined && mono - at < TIMINGS.answerBy;
  }

  withdrawDisarms(area) {
    let count = 0;
    for (const ticket of this.disarmTickets) {
      if (ticket.area === area && !ticket.writing && !ticket.withdrawn) {
        ticket.withdrawn = true;
        count += 1;
      }
    }
    if (count > 0) this.logger.warn(`Unset WITHDRAWN (area ${area}): a set was asked after it`);
  }

  /**
   * Arm an area. The arms of one area go one after the other up to their
   * WRITE only (never behind a confirmation); other areas never wait.
   */
  async arm(area, mode, received) {
    const label = `${MODE_NAMES[mode].en} of area ${area}`;
    try {
      this.commonChecks();
    } catch (err) {
      this.logger.warn(`Set REFUSED (${label}): ${err.message}`);
      throw err;
    }
    const client = this.client;
    const generation = this.generation;
    this.withdrawDisarms(area);
    let release;
    const written = new Promise((resolve) => {
      release = resolve;
    });
    const previous = this.armLines.get(area) ?? Promise.resolve();
    const line = previous.then(() => written);
    this.armLines.set(area, line);
    try {
      await previous;
      return await this.armNow(area, mode, received, { client, generation, release, label });
    } finally {
      release();
      if (this.armLines.get(area) === line) this.armLines.delete(area);
    }
  }

  async armNow(area, mode, received, { client, generation, release, label }) {
    const start = this.monotonic();
    if (start >= received + TIMINGS.sendBy) {
      this.logger.warn(`Set REFUSED (${label}): its time ran out behind other sets of the area`);
      throw new Refused(T.errors.busy);
    }
    this.stillSame(client, generation);
    this.commonChecks();
    if (mode !== 'full_set') {
      const current = await this.currentForPart(area, received, client, label);
      this.stillSame(client, generation);
      if (!this.disarmUncertain(area, this.monotonic())) {
        if (current === 'full_set' || current === mode) {
          this.logger.info(`Area ${area} already ${current} (${label}): nothing sent`);
          this.liftGuardIf(area, (g) => shows({ mode: current }, g.mode), 'already shown');
          return;
        }
      }
      if (current === 'part_set_a' || current === 'part_set_b') {
        if (current !== mode) {
          this.logger.warn(`Set REFUSED (${label}): area ${area} is ${current}`);
          throw new Refused(T.errors.otherPartSet(current));
        }
      }
    }
    // A full set is sent whatever the area was last seen in (sending it again lowers nothing).
    const mono = this.monotonic();
    const guard = this.newGuard(area, mode, mono, this.model.areas.get(area));
    const cut = client.cutFrozenReads(TIMINGS.frozenRead);
    if (cut > 0) this.logger.info(`Set (${label}): ${cut} silent read(s) cut`);
    this.logger.info(`SETTING from Gladys: ${label}`);
    const outcome = await this.sendArm(guard, {
      client,
      generation,
      sendBy: received + TIMINGS.sendBy,
      deadline: received + TIMINGS.answerBy,
      onWritten: release,
      label,
    });
    release();
    if (outcome.lifted) throw new Error(T.errors.armReplaced);
    if (!outcome.delivered) {
      throw new Error(
        outcome.sent ? T.errors.disarmNoAnswer(outcome.error) : T.errors.armNotSent(outcome.error),
      );
    }
    const confirmed = await this.confirmArea(area, received + TIMINGS.answerBy, client, (a) =>
      shows(a, mode),
    );
    if (confirmed) {
      // Kept while an unset of Gladys in flight may still land after it.
      this.liftGuardIf(
        area,
        (g) => g === guard && !(g.overlap && this.disarmUncertain(area, this.monotonic())),
        'confirmed',
      );
      this.logger.info(`Set confirmed by the area read back (${label})`);
      return;
    }
    this.logger.warn(`Set sent, NOT confirmed yet (${label}): read again 5, 20 and 60 s later`);
    throw new Error(T.errors.unconfirmed(MODE_NAMES[mode].en));
  }

  /** The mode of the area for a part set: read now, else the last known if it is "unset". */
  async currentForPart(area, received, client, label) {
    const seq = ++this.readSeq;
    try {
      const read = await client.readArea(area, {
        deadline: Math.min(received + TIMINGS.partReadBy, this.monotonic() + TIMINGS.partReadBy),
      });
      this.observeArea(read, seq);
      if (read.mode !== null) return read.mode;
      throw Object.assign(new Error('Mode unknown'), { code: CODES.BAD_ANSWER });
    } catch (err) {
      if (err instanceof Refused) throw err;
      const known = this.model.areas.get(area)?.mode;
      if (known === 'unset') {
        this.logger.warn(
          `Set (${label}): state not read (${err?.code ?? 'error'}), last known unset: sent`,
        );
        return 'unset';
      }
      this.logger.warn(`Set REFUSED (${label}): state not read (${err?.code ?? 'error'})`);
      throw new Refused(T.errors.partStateUnknown(err));
    }
  }

  /**
   * Sends an arm, again every 250 ms while its request does not reach the
   * gateway, until sendBy. -> { delivered, sent, error }. Throws Refused on
   * a refusal of the panel or of the credentials (the guard is lifted).
   */
  async sendArm(guard, { client, generation, sendBy, deadline, onWritten, label }) {
    let sent = false;
    let error;
    this.resending.add(guard.area);
    try {
      for (;;) {
        if (this.guards.get(guard.area) !== guard) {
          // Lifted meanwhile (an unset of Gladys asked after it left).
          return { delivered: false, sent, error, lifted: true };
        }
        const mono = this.monotonic();
        if (sendBy - mono < 50) break;
        if (client !== this.client || generation !== this.generation) break;
        try {
          await client.setMode(guard.area, guard.mode, {
            deadline,
            sendBy,
            onSent: () => {
              sent = true;
              onWritten?.();
            },
          });
          guard.delivered = true;
          void this.save();
          return { delivered: true, sent: true };
        } catch (err) {
          error = err;
          if (err?.code === CODES.FAILED) {
            this.dropGuard(guard, 'refused by the panel');
            this.logger.warn(`Set REFUSED by the panel (${label})`);
            throw new Refused(T.errors.refusedByPanel);
          }
          if (isAuthError(err)) {
            this.dropGuard(guard, 'credentials');
            this.commandAuthRefused = err.code === CODES.AUTH_REFUSED;
            this.logger.warn(`Set REFUSED (${label}): ${err.code}`);
            throw new Refused(
              err.code === CODES.AUTH_REFUSED ? T.errors.authRefused : T.errors.authRequired,
            );
          }
          if (err?.code === CODES.CUT && client.closed) break;
          this.logger.warn(
            `Set (${label}) not delivered: ${err?.code ?? 'error'}${err?.status ? ` ${err.status}` : ''}`,
          );
        }
        const left = sendBy - this.monotonic();
        if (left < TIMINGS.armRetry + 50) break;
        await this.sleep(TIMINGS.armRetry);
      }
    } finally {
      this.resending.delete(guard.area);
      if (this.guards.get(guard.area) === guard) this.scheduleFollow(guard, 0);
    }
    // Not delivered: the guard stays, the next reads send it again.
    void this.save();
    return { delivered: false, sent, error };
  }

  /** Reads the area until it matches, at most until `until` (monotonic). */
  async confirmArea(area, until, client, matches) {
    for (;;) {
      const mono = this.monotonic();
      if (until - mono < 300) return false;
      const seq = ++this.readSeq;
      try {
        const read = await client.readArea(area, { deadline: until });
        this.observeArea(read, seq);
        if (matches(read)) return true;
      } catch {
        // Not read: tried again while there is time.
      }
      if (client !== this.client) return false;
      if (until - this.monotonic() < 600) return false;
      await this.sleep(300);
    }
  }

  // --- Guards ----------------------------------------------------------------

  newGuard(area, mode, mono, known) {
    const previous = this.guards.get(area);
    if (previous) this.clearFollow(previous);
    const guard = {
      area,
      mode,
      at: this.now(),
      atMono: mono,
      resends: 0,
      delivered: false,
      setTime: known?.lastSetTime ?? null,
      overlap: this.disarmUncertain(area, mono),
      followIndex: 0,
      restart: false,
      followTimer: undefined,
    };
    this.guards.set(area, guard);
    void this.save();
    return guard;
  }

  clearFollow(guard) {
    if (guard.followTimer !== undefined) {
      this.timers.clearTimeout(guard.followTimer);
      guard.followTimer = undefined;
    }
  }

  dropGuard(guard, why) {
    if (this.guards.get(guard.area) !== guard) return;
    this.clearFollow(guard);
    this.guards.delete(guard.area);
    this.logger.info(`Guard of area ${guard.area} lifted: ${why}`);
    void this.save();
  }

  liftGuardIf(area, test, why) {
    const guard = this.guards.get(area);
    if (guard && test(guard)) this.dropGuard(guard, why);
  }

  /** The next follow-up read of a guard, `index` in TIMINGS.followUps (restarted at 0 by a send). */
  scheduleFollow(guard, index = guard.followIndex) {
    this.clearFollow(guard);
    guard.followIndex = index;
    if (index >= TIMINGS.followUps.length || !this.running) return;
    const epoch = this.epoch;
    const delay =
      index === 0 ? TIMINGS.followUps[0] : TIMINGS.followUps[index] - TIMINGS.followUps[index - 1];
    guard.followTimer = this.timers.setTimeout(() => {
      guard.followTimer = undefined;
      if (epoch !== this.epoch || this.guards.get(guard.area) !== guard) return;
      this.followUp(guard).catch((err) =>
        this.logger.error(`Unexpected error (${err?.name ?? 'Error'})`),
      );
    }, delay);
  }

  async followUp(guard) {
    const client = this.client;
    const index = guard.followIndex;
    const final = index >= TIMINGS.followUps.length - 1;
    guard.followIndex = index + 1;
    if (!client || this.authStop || this.identity === 'other') {
      if (!final) this.scheduleFollow(guard, index + 1);
      return;
    }
    const seq = ++this.readSeq;
    let area;
    try {
      area = await client.readArea(guard.area);
    } catch (err) {
      this.logger.debug(`Follow-up read of area ${guard.area} failed: ${err?.code ?? 'error'}`);
    }
    if (client !== this.client || this.guards.get(guard.area) !== guard) return;
    if (area) this.observeArea(area, seq);
    this.evaluateGuard(guard, area, { final });
    if (
      this.guards.get(guard.area) === guard &&
      guard.followTimer === undefined &&
      !this.resending.has(guard.area)
    ) {
      this.scheduleFollow(guard, index + 1);
    }
  }

  /** Every guard against the areas the model holds (after a read). */
  checkGuards() {
    for (const guard of [...this.guards.values()]) {
      this.evaluateGuard(guard, this.model.areas.get(guard.area), { restart: guard.restart });
      guard.restart = false;
    }
  }

  /**
   * A guard against an area just read: lifted when the area shows it, when
   * it expired, when the area was set then unset by someone else; sent again
   * when it never reached the gateway, when an unset of Gladys may have
   * landed after it, after a restart, or at the last follow-up read.
   */
  evaluateGuard(guard, area, { final = false, restart = false } = {}) {
    const mono = this.monotonic();
    if (mono - guard.atMono >= TIMINGS.guardLife) {
      this.dropGuard(guard, 'expired');
      return;
    }
    if (!area || area.mode === null) return;
    // An unset of Gladys in flight may still land after this set: wait for it.
    if (guard.overlap && this.disarmUncertain(guard.area, mono)) return;
    if (shows(area, guard.mode)) {
      this.dropGuard(guard, `area shows ${area.mode}`);
      return;
    }
    if (
      !guard.overlap &&
      area.mode === 'unset' &&
      guard.setTime !== null &&
      area.lastSetTime !== null &&
      area.lastSetTime !== guard.setTime
    ) {
      this.dropGuard(guard, 'the area was set, then unset by someone');
      return;
    }
    if (!(!guard.delivered || final || restart || guard.overlap)) return;
    if (this.resending.has(guard.area) || this.armLines.has(guard.area)) return;
    if (!this.client || this.authStop || this.commandAuthRefused || this.identity === 'other')
      return;
    if (guard.resends >= LIMITS.armResends) {
      this.logger.warn(
        `Set of area ${guard.area} (${guard.mode}) not applied after ${guard.resends} new tries: given up`,
      );
      this.dropGuard(guard, 'given up');
      return;
    }
    guard.resends += 1;
    guard.overlap = false;
    this.logger.warn(
      `Set of area ${guard.area} (${guard.mode}) not shown: sent again (${guard.resends}/${LIMITS.armResends})`,
    );
    const client = this.client;
    const generation = this.generation;
    client.cutFrozenReads(TIMINGS.frozenRead);
    this.sendArm(guard, {
      client,
      generation,
      sendBy: mono + TIMINGS.sendBy,
      deadline: mono + TIMINGS.answerBy,
      label: `${MODE_NAMES[guard.mode].en} of area ${guard.area}, again`,
    }).catch((err) => this.logger.debug(`New try ended: ${err?.message}`));
  }

  // --- Unset -----------------------------------------------------------------

  async disarm(area, received) {
    const label = `Unset of area ${area}`;
    const ticket = { area, received, withdrawn: false, writing: false };
    try {
      this.commonChecks();
      this.disarmAllowed();
    } catch (err) {
      this.logger.warn(`${label} REFUSED: ${err.message}`);
      throw err;
    }
    const client = this.client;
    const generation = this.generation;
    this.disarmTickets.add(ticket);
    const previous = this.disarmLines.get(area) ?? Promise.resolve();
    const run = previous.then(() => this.disarmNow(ticket, { client, generation, label }));
    const line = run.catch(() => {});
    this.disarmLines.set(area, line);
    try {
      return await run;
    } catch (err) {
      if (err instanceof Refused) this.logger.warn(`${label} REFUSED: ${err.message}`);
      throw err;
    } finally {
      this.disarmTickets.delete(ticket);
      if (this.disarmLines.get(area) === line) this.disarmLines.delete(area);
    }
  }

  disarmAllowed() {
    if (!this.config.allowDisarm) throw new Refused(T.errors.disarmDisabled);
    if (this.identity !== 'ok') throw new Refused(T.errors.identityUnknown);
  }

  async disarmNow(ticket, { client, generation, label }) {
    const { area, received } = ticket;
    const check = () => {
      if (ticket.withdrawn) throw new Refused(T.errors.disarmWithdrawn);
      this.stillSame(client, generation);
      this.commonChecks();
      this.disarmAllowed();
    };
    check();
    if (this.monotonic() >= received + TIMINGS.readBy - 200) throw new Refused(T.errors.busy);
    const seq = ++this.readSeq;
    let current;
    let panel;
    try {
      // The area and the identity of the panel, read now, side by side.
      [current, panel] = await Promise.all([
        client.readArea(area, { deadline: received + TIMINGS.readBy }),
        client.readPanel({ deadline: received + TIMINGS.readBy }).catch(() => null),
      ]);
    } catch (err) {
      if (err instanceof Refused) throw err;
      throw new Refused(T.errors.stateUnknown(err));
    }
    this.observeArea(current, seq);
    check();
    if (!panel?.serial || panel.serial !== this.memory?.panel) {
      this.logger.warn(
        `${label} REFUSED: the serial number of the panel not read now or another one`,
      );
      throw new Refused(T.errors.identityNow);
    }
    if (current.mode === null) throw new Refused(T.errors.stateUnknown());
    // Never "already unset" while a set of Gladys may still apply.
    if (current.mode === 'unset' && !this.guards.has(area) && !this.model.verified.has(area)) {
      this.logger.info(`Area ${area} already unset: nothing sent`);
      return;
    }
    const mono = this.monotonic();
    const writes = (this.disarmWrites.get(area) ?? []).filter((at) => mono - at < MINUTE);
    this.disarmWrites.set(area, writes);
    if (writes.length >= LIMITS.disarmsPerMinute) {
      throw new Refused(T.errors.tooManyDisarms(LIMITS.disarmsPerMinute));
    }
    if (mono >= received + TIMINGS.sendBy - 100) throw new Refused(T.errors.busy);
    // The last check, synchronous, right before the request is issued.
    check();
    ticket.writing = true;
    let sent = false;
    this.logger.info(`UNSETTING from Gladys: ${label} (area read: ${current.mode})`);
    try {
      await client.setMode(area, 'unset', {
        deadline: received + TIMINGS.answerBy,
        sendBy: received + TIMINGS.sendBy,
        onSent: () => {
          if (sent) return;
          sent = true;
          const at = this.monotonic();
          writes.push(at);
          this.disarmsInFlight.set(area, (this.disarmsInFlight.get(area) ?? 0) + 1);
          // A set of this area asked before this unset: this unset, more recent, wins.
          this.liftGuardIf(area, (g) => g.atMono < received, 'an unset asked after it left');
        },
      });
    } catch (err) {
      this.disarmSettled(area, sent);
      if (!sent || err?.notSent) throw new Refused(T.errors.disarmNotSent(err));
      if (err?.code === CODES.FAILED) throw new Error(T.errors.refusedByPanel, { cause: err });
      if (isAuthError(err)) {
        this.commandAuthRefused = err.code === CODES.AUTH_REFUSED;
        throw new Error(T.errors.authRefused, { cause: err });
      }
      this.readBack(area, client);
      throw new Error(T.errors.disarmNoAnswer(err), { cause: err });
    }
    this.disarmSettled(area, sent);
    const confirmed = await this.confirmArea(
      area,
      received + TIMINGS.answerBy,
      client,
      (a) => a.mode === 'unset',
    );
    if (confirmed) {
      this.model.verified.delete(area);
      this.logger.info(`Unset confirmed by the area read back (${label})`);
      return;
    }
    this.readBack(area, client);
    this.logger.warn(`Unset sent, NOT confirmed yet (${label})`);
    throw new Error(T.errors.unconfirmed(MODE_NAMES.unset.en));
  }

  /** A disarm answered (or failed): a guard waiting for it is checked at once. */
  disarmSettled(area, sent) {
    if (!sent) return;
    const left = (this.disarmsInFlight.get(area) ?? 1) - 1;
    if (left > 0) this.disarmsInFlight.set(area, left);
    else this.disarmsInFlight.delete(area);
    this.disarmSettledAt.set(area, this.monotonic());
    const guard = this.guards.get(area);
    if (guard?.overlap) this.scheduleFollow(guard, 0);
  }

  /** The area read again 5 and 20 s after an unset not confirmed (states only). */
  readBack(area, client) {
    for (const delay of TIMINGS.followUps.slice(0, 2)) {
      const timer = this.timers.setTimeout(() => {
        this.readBacks.delete(timer);
        if (client !== this.client) return;
        const seq = ++this.readSeq;
        client
          .readArea(area)
          .then((read) => {
            if (client === this.client) this.observeArea(read, seq);
          })
          .catch((err) => this.logger.debug(`Read back failed: ${err?.code ?? 'error'}`));
      }, delay);
      this.readBacks.add(timer);
    }
  }

  // --- Configuration buttons ---------------------------------------------------

  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /**
   * The configuration read again, one try despite a stop on credentials (at
   * most one per 10 s), a read when the pace allows it, then a report.
   */
  async testConnection() {
    await this.within(this.test(), TIMINGS.testBudget, T.errors.testTooLong);
    const mono = this.monotonic();
    if (this.online && this.identity !== 'other' && this.lastReadAt !== undefined) {
      return T.test.ok({
        areas: this.model.areas.size,
        zones: this.model.zones.size,
        ago: mono - this.lastReadAt,
      });
    }
    const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
    const left = this.client && this.memory ? this.dueAt(mono) - mono : 0;
    if (left > 0 && !this.online && !this.authStop) {
      throw new Error(`${message?.en ?? T.errors.notConfigured} ${T.test.wait(left).en}`);
    }
    throw new Error(message?.en ?? T.errors.notConfigured);
  }

  async test() {
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      throw new Error(T.errors.configNotRead, { cause: err });
    }
    await this.start(raw, { force: true });
    if (!this.client || !this.memory || this.authStop) return;
    const mono = this.monotonic();
    if (mono >= this.dueAt(mono)) {
      await this.tick();
      this.schedule();
    }
  }

  /** "Use the panel that answers": pins the serial the status shows. */
  async acceptPanel() {
    if (this.identity !== 'other' || !this.seenSerial || !this.memory) {
      throw new Error(T.errors.nothingToAccept);
    }
    const serial = this.seenSerial;
    this.memory.panel = serial;
    this.identity = 'ok';
    this.seenSerial = null;
    // The guards were asked of the other panel.
    for (const guard of [...this.guards.values()]) this.dropGuard(guard, 'panel replaced');
    await this.save();
    this.logger.info(`Panel ${serial} accepted by the user`);
    // Its areas and zones come with the next read (never sooner than the pace).
    return T.test.accepted(serial);
  }
}
