// -----------------------------------------------------------------------------
// The answers of the gateway, checked field by field (pyspcwebgw
// __init__.py, area.py, zone.py): { status: "success", data: { <resource> } }.
// Only own keys are read (never an inherited or `__proto__` key); ids are
// digits; codes are the known ones, anything else is "unknown" (null), never
// guessed; names are cleaned of control characters and capped. One linear
// pass over a bounded body (the transport caps it).
// -----------------------------------------------------------------------------

import { LIMITS, MODE_OF_CODE, ZONE_INPUT, ZONE_STATUS } from '../constants.js';
import { CODES, GatewayError } from './errors.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const ID = new RegExp(`^\\d{1,${LIMITS.maxIdDigits}}$`);
const SERIAL = /^[A-Za-z0-9._-]{1,32}$/;
const TIME = /^\d{1,12}$/;
const INPUTS = new Set(Object.values(ZONE_INPUT));
const STATUSES = new Set(Object.values(ZONE_STATUS));

const bad = (message) => new GatewayError(CODES.BAD_ANSWER, message);

/** An id of the gateway ("1", 1) as a canonical string ("1"), else null. */
export function idOf(value) {
  const raw = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || !ID.test(raw)) return null;
  return String(Number(raw));
}

/** A code of a small enumeration ("0".."30", or the number): its string, else null. */
const codeOf = (value) => {
  const raw = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  return typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? String(Number(raw)) : null;
};

/** A name shown in Gladys: no control character, trimmed, capped; '' when none. */
export function cleanName(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return [...value.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').trim()]
    .slice(0, LIMITS.maxName)
    .join('');
}

const timeOf = (value) => {
  const raw = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  return typeof raw === 'string' && TIME.test(raw) ? Number(raw) : null;
};

/** The JSON envelope: the `data[resource]` of a success; throws a GatewayError else. */
export function dataOf(body, resource) {
  let json;
  try {
    json = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  } catch {
    throw bad('Not JSON');
  }
  if (!isObject(json)) throw bad('Not an object');
  if (own(json, 'status') !== 'success') {
    throw new GatewayError(CODES.FAILED, 'The gateway did not report a success');
  }
  if (resource === undefined) return undefined;
  const data = own(own(json, 'data'), resource);
  if (data === undefined) throw bad(`No ${resource} in the answer`);
  return data;
}

/** /spc/panel -> { serial, type, variant, version } (serial null when unreadable). */
export function parsePanel(data) {
  if (!isObject(data)) throw bad('No panel');
  const sn = own(data, 'sn');
  return {
    serial: typeof sn === 'string' && SERIAL.test(sn) ? sn : null,
    type: cleanName(own(data, 'type')),
    variant: cleanName(own(data, 'variant')),
    version: cleanName(own(data, 'version')),
  };
}

/** One area -> { id, name, mode, lastSetTime, lastUnsetTime } or null. */
export function parseArea(data) {
  const id = idOf(own(data, 'id'));
  if (id === null) return null;
  const code = codeOf(own(data, 'mode'));
  return {
    id,
    name: cleanName(own(data, 'name')),
    mode: code !== null && Object.hasOwn(MODE_OF_CODE, code) ? MODE_OF_CODE[code] : null,
    lastSetTime: timeOf(own(data, 'last_set_time')),
    lastUnsetTime: timeOf(own(data, 'last_unset_time')),
  };
}

/** One zone -> { id, name, area, type, input, status } or null. */
export function parseZone(data) {
  const id = idOf(own(data, 'id'));
  if (id === null) return null;
  const input = codeOf(own(data, 'input'));
  const status = codeOf(own(data, 'status'));
  return {
    id,
    name: cleanName(own(data, 'zone_name')),
    area: idOf(own(data, 'area')),
    type: codeOf(own(data, 'type')),
    input: input !== null && INPUTS.has(input) ? input : null,
    status: status !== null && STATUSES.has(status) ? status : null,
  };
}

/**
 * A list of areas or zones: invalid entries and duplicates dropped (counted),
 * at most `max` kept. The gateway gives a list, or a single object.
 */
export function parseList(data, parse, max) {
  const items = Array.isArray(data) ? data : isObject(data) ? [data] : null;
  if (!items) throw bad('No list');
  const byId = new Map();
  let dropped = 0;
  for (const item of items) {
    const parsed = parse(item);
    if (!parsed || byId.has(parsed.id) || byId.size >= max) {
      dropped += 1;
      continue;
    }
    byId.set(parsed.id, parsed);
  }
  return { byId, dropped };
}

/**
 * One area or zone read by id (/spc/area/<id>: a list of one for areas,
 * an object for zones, pyspcwebgw): the entry of that id, else a bad answer.
 */
export function parseOne(data, parse, id) {
  const item = Array.isArray(data) ? data[0] : data;
  const parsed = parse(item);
  if (!parsed || parsed.id !== id) throw bad('Not the entry asked');
  return parsed;
}

/**
 * A websocket message: { data: { sia: { sia_address, sia_code, description } } }
 * -> { address, code } or null. The description (user names) is not kept.
 */
export function parseEvent(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const sia = own(own(json, 'data'), 'sia');
  const code = own(sia, 'sia_code');
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) return null;
  return { code, address: idOf(own(sia, 'sia_address')) };
}
