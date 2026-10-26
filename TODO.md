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
      Digest, real clock sped up 100 times).
- [ ] **Milestone 2 - real gateway**: run against a real SPC Web Gateway and
      panel; capture real answers and events (anonymised) as fixtures; fix
      what differs (see "To check").
- [ ] **Milestone 3 - more**: outputs (mapping gates, behind their own
      option, never a switch), zone inhibit / isolate behind an option,
      scene triggers (`alarm_triggered`, `set`, `unset`), event log, the
      `ready to set` state (`not_ready_set`).
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

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

## Decisions

- **Version 0.1.0, set by hand once** (package.json, package-lock.json, the
  manifest `version` and the `docker_image` tag); every later version comes
  from Actions -> Release (the first patch release gives 0.1.1).
- **SDK `^0.15.0`**: 0.16.0 is tagged on GitHub but not published on npm
  (`npm view` gives 0.15.0 on 2026-10-26); migrate when it is.
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
- **Set (arm) is protective**: no option, no identity, no read needed (works
  before the first read and while /data is unreadable); never behind a read
  (own TCP connection per request; a read silent for 1 s is cut), nor the
  waits after failed reads, nor an unset waiting (withdrawn by the set).
  Tried every 250 ms while not delivered, until 3.5 s; confirmed by a read of
  the area until 4.3 s. Refusal cases listed in the docs and the manifest.
- **Guards**: a set not seen applied keeps a guard (area, mode, last set
  time, resends; in `/data`, 10 min at most). Sent again (3 times at most)
  when never delivered (next read), once an unset of Gladys in flight at the
  press may have landed after it, after a restart, at the 60 s follow-up read
  if still not shown. Lifted when the area shows it (a full set covers a part
  set), when `last_set_time` moved and the area reads unset (set then unset
  by someone), by an unset of Gladys asked after it once its request left.
  The guard waits while an unset in flight may still land.
- **Part set never lowers**: over a full set nothing is sent (success); over
  the other part set refused; decided on a fresh read (1.2 s), else sent only
  when the last state read is unset.
- **Unset (disarm)**: option `allow_disarm` off by default, checked when
  asked and synchronously right before the request; identity (serial) read in
  this session and read again with the fresh read of the area (unreadable or
  another one: refused); one at a time per area; fresh read by 2.5 s; never "already
  unset" while a guard of a set exists; 6 per area per minute (sets never
  limited); confirmed by a read; read back at 5 and 20 s otherwise.
- **Credentials**: sent only in answer to a 401 challenge (Digest preferred,
  else Basic), never preemptively, never in a URL. A 401 on credentials built
  from a fresh challenge (or on Basic) is a refusal; on a reused Digest nonce
  it is answered again once. A refusal on the areas (main resource) stops
  everything, kept in `/data` as `{ salt, 8-bit mark }` (never a findable
  hash); same credentials after a restart: no try; other credentials lift it;
  "Test the connection" makes one try (at most every 10 s). A 401 on the
  zones, the panel, the websocket or a command never stops the reads.
- **Identity**: the panel serial (`sn`) is read at every read, learnt at the
  first one; another
  one stops publications and commands (status shows it) until "Use the panel
  that answers"; an unreadable serial changes nothing (unset refused until it
  is read in the session).
- **Guard written to /data without waiting**: the set is never delayed by the
  write of its guard (a set lost by a crash in that instant is not sent again
  after the restart).
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
