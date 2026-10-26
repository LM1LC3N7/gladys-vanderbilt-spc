// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS, ZONE_KINDS } from './constants.js';

export const LANGUAGES = Object.freeze(['fr', 'en']);

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  allow_disarm: false,
  language: 'fr',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * The address of the gateway: `192.168.1.10`, `spc.local`, `host:port` or
 * `http://host[:port]` (port 8088 by default). Plain HTTP only (the gateway
 * as pyspcwebgw and Home Assistant use it). Credentials, a path, a query
 * and a fragment are refused (an address ends up in logs; the credentials
 * have their own fields).
 *   -> { origin, hostname, port, host } or { error: 'empty' | 'invalid' | 'credentials' | 'https' }
 */
export function parseHost(value) {
  const raw = text(value);
  if (!raw) return { error: 'empty' };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === 'https') return { error: 'https' };
  if (scheme && scheme !== 'http') return { error: 'invalid' };
  let url;
  try {
    url = new URL(scheme ? raw : `http://${raw}`);
  } catch {
    return { error: 'invalid' };
  }
  if (url.username || url.password) return { error: 'credentials' };
  if (url.search || url.hash || !url.hostname || url.pathname.replace(/\/+$/, '') !== '') {
    return { error: 'invalid' };
  }
  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  const hostname = url.hostname.toLowerCase();
  const host = `${hostname}:${port}`;
  return { origin: `http://${host}`, hostname, port, host };
}

/**
 * "5:opening, 12:motion": how some zones show, by their number. Unknown
 * kinds or numbers are counted (never shown back: a password may have been
 * pasted here by mistake).
 *   -> { kinds: Map<string, kind>, invalid: number }
 */
export function parseZoneKinds(value) {
  const kinds = new Map();
  let invalid = 0;
  const raw = text(value);
  if (!raw) return { kinds, invalid };
  for (const part of raw
    .split(/[,;\s]+/)
    .filter(Boolean)
    .slice(0, LIMITS.maxZones)) {
    const match = /^(\d{1,4}):([a-z]+)$/.exec(part.toLowerCase());
    if (!match || !ZONE_KINDS.includes(match[2])) {
      invalid += 1;
      continue;
    }
    kinds.set(String(Number(match[1])), match[2]);
  }
  return { kinds, invalid };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const gateway = parseHost(raw.host);
  const username = text(raw.username);
  // The password is taken as typed (spaces may belong to it), never trimmed.
  const password = typeof raw.password === 'string' ? raw.password : '';
  let credentialsError = null;
  if (password && !username) credentialsError = 'password_alone';
  else if (username && !password) credentialsError = 'username_alone';
  else if (CONTROL.test(username) || CONTROL.test(password) || username.includes(':')) {
    credentialsError = 'characters';
  } else if (username.length > 128 || password.length > 256) credentialsError = 'length';
  const language = LANGUAGES.includes(String(raw.language))
    ? String(raw.language)
    : DEFAULTS.language;
  const zoneKinds = parseZoneKinds(raw.zone_kinds);
  return {
    gateway: gateway.error ? null : gateway,
    hostError: gateway.error ?? null,
    credentials: username && password && !credentialsError ? { username, password } : null,
    credentialsError,
    allowDisarm: bool(raw.allow_disarm, DEFAULTS.allow_disarm),
    zoneKinds: zoneKinds.kinds,
    zoneKindsInvalid: zoneKinds.invalid,
    language,
  };
}

/** The configuration as a key: the same key, the same session (the password included, never logged). */
export const configKey = (config) =>
  JSON.stringify({
    ...config,
    zoneKinds: [...config.zoneKinds.entries()],
  });
