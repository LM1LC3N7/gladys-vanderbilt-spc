// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in spc-state.json, readable by the container user only (0600):
//   - `panel`: the serial number of the panel this integration drives, learnt
//     at the first read; another serial at the same address stops the
//     commands until the user accepts it (button);
//   - `lastAttemptAt`: the wall-clock time of the last read of the areas, so
//     a restart never reads sooner than the interval;
//   - `refused`: the credentials the gateway refused: { at, salt, mark } where
//     `mark` is 8 bits of a salted SHA-256 of the refused user name and
//     password (never a hash a password could be found back from: a short one
//     would be brute-forced from a full hash); new credentials lift it. Never
//     a hash of credentials that work;
//   - `guards`: the arms not yet seen applied, { area, mode, at, resends,
//     delivered, setTime, overlap }, sent again after a restart when the area
//     still does not show them (10 minutes at most).
// A missing file is a first start. A file that cannot be read (EACCES, not
// JSON, too large) is NOT: load() throws and the app does not overwrite it
// (it may hold a refusal or the serial). Read back bounded: only known keys of
// the expected shape (never an inherited or `__proto__` key), every time capped.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/spc-state.json';
const MAX_STATE_BYTES = 16 * 1024;
const SERIAL = /^[A-Za-z0-9._-]{1,32}$/;
const ID = /^\d{1,4}$/;
const ARM_MODES = ['full_set', 'part_set_a', 'part_set_b'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      if (text.length > MAX_STATE_BYTES) {
        throw Object.assign(new Error('State file too large'), { code: 'EFBIG' });
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw Object.assign(new Error('State file not JSON'), { code: 'EINVAL' });
      }
      if (!isObject(data)) {
        throw Object.assign(new Error('State file not an object'), { code: 'EINVAL' });
      }
      return data;
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { failing = false, unreadable = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    unreadable,
    async load() {
      if (this.unreadable) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) throw new Error('EROFS');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** 8 bits of a salted SHA-256 of the credentials (a marker, never a findable hash). */
export function credentialsMark(credentials, salt) {
  const digest = createHash('sha256')
    .update(`${salt}\n${credentials.username}\n${credentials.password}`, 'utf8')
    .digest();
  return digest[0].toString(16).padStart(2, '0');
}

export function refusalOf(credentials, now, random = randomBytes) {
  const salt = random(16).toString('hex');
  return { at: now, salt, mark: credentials ? credentialsMark(credentials, salt) : null };
}

/** The refusal kept applies to these credentials (the same marker). */
export const sameRefused = (refused, credentials) =>
  Boolean(
    refused &&
    credentials &&
    refused.mark !== null &&
    credentialsMark(credentials, refused.salt) === refused.mark,
  );

const finite = (value) => Number.isFinite(value) && value > 0;

function normalizeGuard(raw, now) {
  const area = own(raw, 'area');
  const mode = own(raw, 'mode');
  const at = own(raw, 'at');
  const resends = own(raw, 'resends');
  const setTime = own(raw, 'setTime');
  if (typeof area !== 'string' || !ID.test(area) || !ARM_MODES.includes(mode) || !finite(at)) {
    return null;
  }
  // A guard dated in the future (a clock set back) counts as "just now".
  const when = Math.min(at, now);
  if (now - when >= TIMINGS.guardLife) return null;
  return {
    area,
    mode,
    at: when,
    resends: Number.isInteger(resends) ? Math.min(Math.max(resends, 0), LIMITS.armResends) : 0,
    delivered: own(raw, 'delivered') === true,
    setTime: Number.isInteger(setTime) && setTime >= 0 ? setTime : null,
    overlap: own(raw, 'overlap') === true,
  };
}

/** The persisted state, repaired and bounded against `now` (wall clock). */
export function normalizeMemory(raw, now) {
  const panel = own(raw, 'panel');
  const lastAttemptAt = own(raw, 'lastAttemptAt');
  const refused = own(raw, 'refused');
  const salt = own(refused, 'salt');
  const mark = own(refused, 'mark');
  const refusedAt = own(refused, 'at');
  const guards = own(raw, 'guards');
  const kept = new Map();
  for (const entry of Array.isArray(guards) ? guards.slice(0, LIMITS.maxAreas) : []) {
    const guard = normalizeGuard(entry, now);
    if (guard) kept.set(guard.area, guard);
  }
  return {
    panel: typeof panel === 'string' && SERIAL.test(panel) ? panel : null,
    lastAttemptAt: finite(lastAttemptAt) ? Math.min(lastAttemptAt, now) : 0,
    refused:
      typeof salt === 'string' &&
      /^[0-9a-f]{32}$/.test(salt) &&
      (mark === null || (typeof mark === 'string' && /^[0-9a-f]{2}$/.test(mark)))
        ? { at: finite(refusedAt) ? Math.min(refusedAt, now) : now, salt, mark }
        : null,
    guards: kept,
  };
}

export const serializeMemory = ({ panel, lastAttemptAt, refused, guards }) => ({
  panel,
  lastAttemptAt,
  refused,
  guards: [...guards.values()].map((g) => ({
    area: g.area,
    mode: g.mode,
    at: g.at,
    resends: g.resends,
    delivered: g.delivered,
    setTime: g.setTime,
    overlap: g.overlap,
  })),
});
