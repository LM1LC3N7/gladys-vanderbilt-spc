# TODO - Vanderbilt SPC (SPC Web Gateway) v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 22 and 24, Docker
  build, store validator), `npm audit --omit=dev`, then update README,
  `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the main
  session posts one recap per wave in /t/10385.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-26): REST client and websocket ported
      from pyspcwebgw 0.7.0 (commit 3fac932); panel / area / zone devices;
      read-only states and push buttons; set protective, unset opt-in;
      guards of the sets kept in `/data`; optional Digest / Basic credentials
      with a persisted refusal; panel identity by serial number; "Test the
      connection" and "Use the panel that answers"; fr/en. Tested against an
      in-memory fake gateway, and on loopback (real HTTP and `ws` servers,
      Digest, real clock sped up 20 times).
- [x] **Review 1 fixes** (2026-10-26, review of 4c1086e: 2 blocking, 4
      important): see "Decisions after review 1".
- [ ] **Milestone 2 - real gateway**: run against a real SPC Web Gateway and
      panel; capture real answers and events (anonymised) as fixtures; fix
      what differs (see "To check").
- [ ] **Milestone 3 - more**: outputs (mapping gates, behind their own
      option, never a switch), zone inhibit / isolate behind an option,
      scene triggers (`alarm_triggered`, `set`, `unset`), event log, the
      `ready to set` state (`not_ready_set`).
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## Decisions after review 1

- **B1 (occupant)**: a set the gateway accepted (200 success) is never sent
  again, neither at 60 s nor after a restart: the follow-up reads only
  publish, and at 60 s a set still not shown is dropped with a status line
  (exit time, zone open or cancelled at the keypad). A set never delivered
  (or with no valid answer) is sent again (3 times, 2 minutes at most) only on
  a fresh read (a read that left after the press) showing the area exactly as
  the reference read less than 150 s before the press (mode, last set time,
  last unset time) and no set/unset SIA event (CG, NL, OG, CL, OP) since the
  press; no reference, no resend. Only delivered=false guards go to /data.
- **B2 (older unset after a newer set)**: an unset counts in flight from its
  decision (before the request); a set withdraws an unset whose connection is
  not up (the request handle is aborted: nothing leaves) and is marked
  `overlap` when one is on the wire: once that unset is answered, a fresh read
  decides one resend.
- **Review 2**: `overlap` only when an unset of Gladys is in flight (decided,
  not answered) at the press; its reference is the area read after that
  unset's answer, with the same checks (times, and SIA events since that
  unset left: only its own unset event and this set's own set event are
  ignored, once each; review 3); no reference, no resend. A fresh read must have started after
  the press. With no times from the gateway, a resend needs the websocket
  live since the press. "Test the connection" forgets the Digest memory only
  after a downgrade stop. Status notices: "N min ago", dropped after 1 h or
  when the area is set.
- **I3**: a 4xx answer to a set is a refusal (one request, the exact reason);
  5xx: one more try; `failed`: the area is read, shown = success.
- **I4**: Basic only with the `allow_basic` option (off by default), with a
  lasting status line; never after Digest worked (scheme kept in /data;
  "Test the connection" forgets it).
- **I5**: a refusal of the credentials kept does not refuse a set: one try
  per press; a success lifts the refusal and resumes the reads.

## To check on a real gateway

- The authentication of the gateway: none, Basic or Digest (Home Assistant
  and pyspcwebgw send none; the integration answers a 401 challenge only).
- The websocket path: `ws://<host>:8088/ws/spc` assumed (Home Assistant
  docs); pyspcwebgw takes the URL as given.
- What an area reads during the exit time of a set (mode 0 until set, or the
  set mode at once?), and the answer of `PUT .../set` on an area not ready
  (zone open): `{ status: "failed" }` assumed.
- Whether `last_set_time` moves for a part set (pyspcwebgw says the user is
  not given for part sets): the guard relies on it to see a keypad unset.
- The size of `/spc/zone` with 512 zones (1 MB cap).
- Whether `PUT set` on an area already fully set is a success or a failure.
- The serial number in `/spc/panel` (`sn`) on every firmware.
- Whether the gateway reports its own unset (the unset sent by the
  integration) as an event: the one `overlap` resend ignores exactly that
  event and the set's own; if the gateway does not report it, a keypad action
  in the same second as the integration's unset is not seen and the set is
  resent once (review 3, scenario s8).

## Decisions

- **Version 0.1.0, set by hand once** (package.json, package-lock.json, the
  manifest `version` and the `docker_image` tag); every later version comes
  from Actions -> Release (the first patch release gives 0.1.1).
- **SDK `^0.16.0`** (2026-10-27, migration wave 2): 0.16.0 is on npm since
  2026-10-25 (a stale npm cache said otherwise); it adds the ai, tts and music
  types; no effect here (`should_poll` explicit, `poll_frequency` unused).
  `keywords`, `countries` and `gladys_version >= 5.3.0` wait until Gladys 5.3
  is widespread.
- **Manifest**: `gladys_version >=5.1.0`, category `security`; no `keywords`
  nor `countries` yet (they need 5.3.0). Planned keywords: vanderbilt, spc,
  siemens, lundix, alarm, alarme, intrusion; countries: SE, CH, DE, AT, NL,
  BE, FR, GB, IE, DK, NO, FI.
- **Port of pyspcwebgw (MIT)**, credited in `THIRD_PARTY_NOTICES.md`, copied
  into the image with `LICENSE`. The websocket uses `ws` (MIT, as
  gladys-blue-current): it bounds the messages and lets the handshake carry an
  Authorization header; Node's WebSocket does neither.
- **No dedicated alarm device type for integrations in the core**: the mode is
  a text, armed an input, alarm a siren (read-only), the commands are
  `button`/`push` (as gladys-elk-m1): never a switch nor a binary command.
- **Set (arm) is protective** (see also "Decisions after review 1"): no
  option, no identity, no read needed (works before the first read and while
  /data is unreadable); never behind a read
  (own TCP connection per request; a read silent for 1 s is cut), nor the
  waits after failed reads, nor an unset waiting (withdrawn by the set).
  Tried every 250 ms while not delivered, until 3.5 s; confirmed by a read of
  the area until 4.3 s. Refusal cases listed in the docs and the manifest.
- **Guards**: see "Decisions after review 1" (replaces the first version,
  which sent an accepted set again and could set an area against an occupant).
- **Part set**: over a full set read now nothing is sent (success); over
  the other part set refused; decided on a fresh read (1.2 s), else sent only
  when the last state read is unset.
- **Unset (disarm)**: option `allow_disarm` off by default, checked when
  asked and synchronously right before the request; identity (serial) read in
  this session and read again with the fresh read of the area (unreadable or
  another one: refused); one at a time per area; fresh read by 2.5 s; never "already
  unset" while a guard of a set exists; 6 per area per minute (sets never
  limited); confirmed by a read; read back at 5 and 20 s otherwise.
- **Credentials**: sent only in answer to a 401 challenge (Digest; Basic only
  with `allow_basic`, never after Digest worked), never preemptively, never
  in a URL. A 401 on credentials built
  from a fresh challenge (or on Basic) is a refusal; on a reused Digest nonce
  it is answered again once. A refusal on the areas (main resource) stops
  everything, kept in `/data` as `{ salt, 8-bit mark }` (never a findable
  hash); same credentials after a restart: no try; other credentials lift it;
  "Test the connection" makes one try (at most every 10 s); a set makes one
  try per press and its success lifts the refusal. A 401 on the
  zones, the panel, the websocket or a command never stops the reads.
- **Identity**: the panel serial (`sn`) is read at every read, learnt at the
  first one; another one stops publications and commands (status shows it) until "Use the panel
  that answers"; an unreadable serial changes nothing (unset refused until it
  is read in the session).
- **Guard written to /data without waiting**: the set is never delayed by the
  write of its guard (a set lost by a crash in that instant is not sent again
  after the restart, which is the cautious side).
- **Pace**: reads every 60 s (monotonic clock, one read of the clock per
  decision: `dueAt(mono)`); the time of the attempt kept in `/data` before the
  read (written at most once a minute); failures 30 s doubling to 5 min, never
  sooner than 60 s; the test button, Discovery, Gladys reconnecting and
  "Use the panel that answers" never read sooner.
- **Events**: SIA codes of pyspcwebgw; an event reads only the area or zone it
  names (known ones; a new one waits for the next full read); 1 read per
  250 ms; more than 32 waiting: everything read; more than 600 messages a
  minute: socket closed (a flood); ping 30 s; a websocket refused (401) is
  not retried in the session.
- **Freshness**: states published only from a full read less than 150 s old;
  reads are numbered, an older answer never overwrites a newer one.
- **Zones**: kind from the type of the panel (as Home Assistant: alarm
  motion, entry/exit opening, fire smoke; water leak; others input), or the
  `zone_kinds` option; a created zone keeps the kind it was created with
  until "Update" (states go to the feature it has).
- **Logs**: codes and statuses only; never a password, an Authorization
  header, a user name of the panel nor the text of an answer.
