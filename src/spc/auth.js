// -----------------------------------------------------------------------------
// HTTP authentication of the gateway, only when the user gave a user name and
// a password, and only in answer to a challenge of the gateway (401 with
// WWW-Authenticate): Digest (RFC 7616, MD5 or SHA-256, qop "auth") or Basic.
// Nothing is sent before the gateway asks, so a gateway without
// authentication never receives the password, and a Digest gateway never
// receives it in clear.
//
// The credentials go to the configured address only (no redirect is ever
// followed) and are never logged: the headers built here are not either.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

/** A challenge longer than this is not one we answer. */
const MAX_CHALLENGE = 2048;

/**
 * The challenge we can answer in a WWW-Authenticate header: Digest first,
 * then Basic. -> { scheme: 'digest', realm, nonce, opaque, algorithm, qop, stale }
 * | { scheme: 'basic', realm } | null
 */
export function parseChallenge(header) {
  const values = (Array.isArray(header) ? header : [header]).filter(
    (v) => typeof v === 'string' && v.length <= MAX_CHALLENGE,
  );
  let basic = null;
  for (const value of values) {
    const scheme = /^\s*([A-Za-z]+)\s*/.exec(value);
    if (!scheme) continue;
    const name = scheme[1].toLowerCase();
    const params = {};
    const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g;
    re.lastIndex = scheme[0].length;
    let match;
    while ((match = re.exec(value)) !== null) {
      const key = match[1].toLowerCase();
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      params[key] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3];
    }
    if (name === 'digest' && params.nonce && params.realm !== undefined) {
      const algorithm = (params.algorithm ?? 'MD5').toUpperCase();
      if (!['MD5', 'SHA-256'].includes(algorithm)) continue;
      const qops = (params.qop ?? '').split(',').map((q) => q.trim().toLowerCase());
      if (params.qop !== undefined && !qops.includes('auth')) continue;
      return {
        scheme: 'digest',
        realm: params.realm,
        nonce: params.nonce,
        opaque: params.opaque,
        algorithm,
        qop: params.qop !== undefined ? 'auth' : undefined,
        stale: String(params.stale ?? '').toLowerCase() === 'true',
      };
    }
    if (name === 'basic' && !basic) basic = { scheme: 'basic', realm: params.realm ?? '' };
  }
  return basic;
}

const quote = (value) => `"${String(value).replace(/["\\]/g, '\\$&')}"`;

/**
 * The Authorization header for one request, from the challenge; `nc` counts
 * the uses of a Digest nonce (kept in the challenge object).
 */
export function authorization(
  challenge,
  { username, password },
  method,
  uri,
  random = randomBytes,
) {
  if (challenge.scheme === 'basic') {
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  }
  const hash = (text) =>
    createHash(challenge.algorithm === 'SHA-256' ? 'sha256' : 'md5')
      .update(text, 'utf8')
      .digest('hex');
  const ha1 = hash(`${username}:${challenge.realm}:${password}`);
  const ha2 = hash(`${method}:${uri}`);
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(uri)}`,
    `algorithm=${challenge.algorithm}`,
  ];
  let response;
  if (challenge.qop) {
    challenge.nc = (challenge.nc ?? 0) + 1;
    const nc = challenge.nc.toString(16).padStart(8, '0');
    const cnonce = random(8).toString('hex');
    response = hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
    parts.push(`qop=auth`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
  } else {
    response = hash(`${ha1}:${challenge.nonce}:${ha2}`);
  }
  parts.push(`response=${quote(response)}`);
  if (challenge.opaque !== undefined) parts.push(`opaque=${quote(challenge.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}
