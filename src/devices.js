// -----------------------------------------------------------------------------
// The panel model -> Gladys devices and states (pure).
//
// Ids are the numbers the panel gives (a new address of the gateway keeps
// the devices); one panel per integration:
// - `panel:spc`: link to the gateway;
// - `area:<id>`: mode (text), armed, alarm, and the arm full / arm part A /
//   arm part B / disarm BUTTONS;
// - `zone:<id>`: one state feature keyed by its kind (`opening`, `motion`,
//   `smoke`, `leak` or `input`), trouble, inhibited or isolated, alarm.
//
// No command is a switch or a binary: a "turn everything off" (voice
// assistants, HomeKit, scenes on switches) must never reach the alarm. The
// states are read-only, the commands are push buttons (the core has no
// alarm-panel feature for integrations; the House alarm of Gladys is its own).
//
// A device published again never loses a feature the user created (Gladys
// would mark it changed, and "Update" would drop its history): the features
// of the created device are kept, and a created zone keeps its kind.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import {
  OPENING_SENSOR_STATE,
  UNUSED_ZONE_TYPE,
  ZONE_INPUT,
  ZONE_KINDS,
  ZONE_KIND_OF_TYPE,
  ZONE_STATUS,
} from './constants.js';
import { DEVICE_NAMES, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';

const binary = (category, type, history = true) => ({
  category,
  type,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: history,
});

const text = {
  category: C.TEXT,
  type: T.TEXT.TEXT,
  min: 0,
  max: 0,
  read_only: true,
  has_feedback: false,
  keep_history: false,
};

const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

export const PANEL_FEATURES = {
  online: binary(C.INPUT, T.INPUT.BINARY),
};

export const AREA_FEATURES = {
  mode: text,
  armed: binary(C.INPUT, T.INPUT.BINARY),
  alarm: binary(C.SIREN, T.SIREN.BINARY),
  'arm-full': button,
  'arm-part-a': button,
  'arm-part-b': button,
  disarm: button,
};

/** The state feature of a zone, by kind (the kind is also its feature key). */
export const zoneState = (kind) =>
  ({
    opening: binary(C.OPENING_SENSOR, T.SENSOR.BINARY),
    motion: binary(C.MOTION_SENSOR, T.SENSOR.BINARY),
    smoke: binary(C.SMOKE_SENSOR, T.SENSOR.BINARY),
    leak: binary(C.LEAK_SENSOR, T.SENSOR.BINARY),
    input: binary(C.INPUT, T.INPUT.BINARY),
  })[kind];

export const ZONE_FEATURES = {
  trouble: binary(C.INPUT, T.INPUT.BINARY),
  bypass: binary(C.INPUT, T.INPUT.BINARY),
  alarm: binary(C.SIREN, T.SIREN.BINARY),
};

export const ids = {
  panel: (gladys) => gladys.externalIds('panel', 'spc'),
  area: (gladys, id) => gladys.externalIds('area', String(id)),
  zone: (gladys, id) => gladys.externalIds('zone', String(id)),
};

/** `<prefix>:area:1:arm-full` -> { kind: 'area', id: '1', key: 'arm-full' }. */
export function parseFeatureId(gladys, externalId) {
  const value = String(externalId ?? '');
  const prefix = ids.panel(gladys).device.replace(/panel:spc$/, '');
  if (!value.startsWith(prefix)) return undefined;
  const match = /^(panel|area|zone):(\d{1,4}|spc):([a-z-]+)$/.exec(value.slice(prefix.length));
  if (!match) return undefined;
  if ((match[1] === 'panel') !== (match[2] === 'spc')) return undefined;
  return { kind: match[1], id: match[1] === 'panel' ? undefined : match[2], key: match[3] };
}

/** The kind of a created zone device (its state feature), if any. */
function createdKind(device) {
  for (const f of device?.features ?? []) {
    const key = String(f?.external_id ?? '')
      .split(':')
      .at(-1);
    if (ZONE_KINDS.includes(key)) return key;
  }
  return undefined;
}

/** The kind of a zone: configured, else the one it was created with, else from its type. */
export function zoneKind(config, zone, created) {
  return (
    config.zoneKinds.get(zone.id) ?? createdKind(created) ?? ZONE_KIND_OF_TYPE[zone.type] ?? 'input'
  );
}

/** A zone that becomes a device: every zone but the unused ones. */
export const isUsedZone = (zone) => zone.type !== UNUSED_ZONE_TYPE;

const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => f?.external_id && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

const feature = (deviceIds, key, name, definition) => ({
  name,
  external_id: deviceIds.feature(key),
  ...definition,
});

/**
 * The devices of the model (areas and zones read from the gateway). The
 * panel always; areas and zones once read.
 */
export function buildDevices(gladys, config, model, created = gladys.devices ?? []) {
  const { language } = config;
  const createdById = new Map(created.map((d) => [d.external_id, d]));
  const make = (deviceIds, name, features, params = []) => ({
    name,
    external_id: deviceIds.device,
    should_poll: false,
    params,
    features: Object.entries(features).map(([key, definition]) =>
      feature(deviceIds, key, word(FEATURE_NAMES[key], language), definition),
    ),
  });
  const panelName = [word(DEVICE_NAMES.panel, language), model.panel?.type]
    .filter(Boolean)
    .join(' ');
  const devices = [make(ids.panel(gladys), panelName, PANEL_FEATURES)];
  for (const area of model.areas?.values() ?? []) {
    devices.push(
      make(
        ids.area(gladys, area.id),
        area.name || word(DEVICE_NAMES.area, language)(area.id),
        AREA_FEATURES,
        [{ name: 'area', value: area.id }],
      ),
    );
  }
  for (const zone of model.zones?.values() ?? []) {
    if (!isUsedZone(zone)) continue;
    const zoneIds = ids.zone(gladys, zone.id);
    const kind = zoneKind(config, zone, createdById.get(zoneIds.device));
    devices.push({
      name: zone.name || word(DEVICE_NAMES.zone, language)(zone.id),
      external_id: zoneIds.device,
      should_poll: false,
      params: [
        { name: 'zone', value: zone.id },
        { name: 'kind', value: kind },
      ],
      features: [
        feature(zoneIds, kind, word(FEATURE_NAMES.kind[kind], language), zoneState(kind)),
        ...Object.entries(ZONE_FEATURES).map(([key, definition]) =>
          feature(zoneIds, key, word(FEATURE_NAMES[`zone-${key}`], language), definition),
        ),
      ],
    });
  }
  return keepCreatedFeatures(devices, created);
}

const flag = (value) => (value === undefined || value === null ? undefined : value ? 1 : 0);

/** The zone input as active (true), inactive (false) or unknown (undefined). */
export function zoneActive(zone) {
  if (zone.input === ZONE_INPUT.OPEN) return true;
  if (zone.input === ZONE_INPUT.CLOSED) return false;
  return undefined;
}

/** A zone in trouble: an input fault (short, cut, masked, offline…), a tamper or a trouble status. */
export function zoneTrouble(zone) {
  if (zone.input === null && zone.status === null) return undefined;
  const inputFault =
    zone.input !== null && zone.input !== ZONE_INPUT.OPEN && zone.input !== ZONE_INPUT.CLOSED;
  return inputFault || zone.status === ZONE_STATUS.TAMPER || zone.status === ZONE_STATUS.TROUBLE;
}

/** The areas in alarm: a zone of the area in alarm, or a verified alarm while armed. */
export function areaAlarm(model, area) {
  if (area.mode === null) return undefined;
  for (const zone of model.zones?.values() ?? []) {
    if (zone.area === area.id && zone.status === ZONE_STATUS.ALARM) return true;
  }
  return Boolean(model.verified?.has(area.id) && area.mode !== 'unset');
}

/**
 * The states of the created devices, from a model read lately:
 * `[{ device_feature_external_id, state | text }]`, only for the features
 * Gladys has. Offline, only the link.
 */
export function buildStates(gladys, config, model, { online, created = gladys.devices ?? [] }) {
  const states = [];
  const { language } = config;
  const createdById = new Map(created.map((d) => [d.external_id, d]));
  // Only the features Gladys has (a kind changed in the configuration shows
  // after "Update" in Discovery).
  const known = new Set(created.flatMap((d) => (d.features ?? []).map((f) => f.external_id)));
  const push = (deviceIds, key, value) => {
    if (value === undefined || !known.has(deviceIds.feature(key))) return;
    states.push({
      device_feature_external_id: deviceIds.feature(key),
      ...(typeof value === 'string' ? { text: value } : { state: value }),
    });
  };
  push(ids.panel(gladys), 'online', online ? 1 : 0);
  if (!online) return states;
  for (const area of model.areas?.values() ?? []) {
    const areaIds = ids.area(gladys, area.id);
    if (!createdById.has(areaIds.device)) continue;
    const alarm = areaAlarm(model, area);
    const mode = area.mode === null ? 'unknown' : alarm ? 'alarm' : area.mode;
    push(areaIds, 'mode', word(MODE_NAMES[mode], language));
    push(areaIds, 'armed', area.mode === null ? undefined : flag(area.mode !== 'unset'));
    push(areaIds, 'alarm', flag(alarm));
  }
  for (const zone of model.zones?.values() ?? []) {
    if (!isUsedZone(zone)) continue;
    const zoneIds = ids.zone(gladys, zone.id);
    const device = createdById.get(zoneIds.device);
    if (!device) continue;
    // The kind feature the device has (a new kind waits for "Update").
    const kind = createdKind(device) ?? zoneKind(config, zone, device);
    const active = zoneActive(zone);
    push(
      zoneIds,
      kind,
      active === undefined
        ? undefined
        : kind === 'opening'
          ? active
            ? OPENING_SENSOR_STATE.OPEN
            : OPENING_SENSOR_STATE.CLOSE
          : flag(active),
    );
    push(zoneIds, 'trouble', flag(zoneTrouble(zone)));
    push(
      zoneIds,
      'bypass',
      zone.status === null
        ? undefined
        : flag(zone.status === ZONE_STATUS.INHIBIT || zone.status === ZONE_STATUS.ISOLATE),
    );
    push(
      zoneIds,
      'alarm',
      zone.status === null ? undefined : flag(zone.status === ZONE_STATUS.ALARM),
    );
  }
  return states;
}
