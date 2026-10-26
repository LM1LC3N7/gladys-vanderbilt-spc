// -----------------------------------------------------------------------------
// Fixed values: manifest keys, SPC codes, Gladys values, limits and timings.
// The SPC codes come from pyspcwebgw (const.py, area.py, zone.py, MIT, see
// THIRD_PARTY_NOTICES.md); the Gladys values mirror server/utils/constants.js.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them. */
export const ACTIONS = Object.freeze({
  TEST_CONNECTION: 'test_connection',
  ACCEPT_PANEL: 'accept_panel',
});

/** The default port of the SPC Web Gateway (pyspcwebgw example, HA docs). */
export const DEFAULT_PORT = 8088;
/** The websocket path of the gateway (HA docs). */
export const WS_PATH = '/ws/spc';

/**
 * Area modes of the gateway (`mode` of /spc/area) and the command of each
 * (PUT /spc/area/<id>/<command>), pyspcwebgw AreaMode and change_mode().
 */
export const AREA_MODE = Object.freeze({
  UNSET: '0',
  PART_SET_A: '1',
  PART_SET_B: '2',
  FULL_SET: '3',
});

/** Our names of the modes (frozen: they key the texts and the buttons). */
export const MODE_OF_CODE = Object.freeze({
  0: 'unset',
  1: 'part_set_a',
  2: 'part_set_b',
  3: 'full_set',
});

export const COMMAND_OF_MODE = Object.freeze({
  unset: 'unset',
  part_set_a: 'set_a',
  part_set_b: 'set_b',
  full_set: 'set',
});

/** The arming buttons of an area: feature key -> mode. */
export const ARM_BUTTONS = Object.freeze({
  'arm-full': 'full_set',
  'arm-part-a': 'part_set_a',
  'arm-part-b': 'part_set_b',
});

/** Zone input (pyspcwebgw ZoneInput). */
export const ZONE_INPUT = Object.freeze({
  CLOSED: '0',
  OPEN: '1',
  SHORT: '2',
  DISCONNECTED: '3',
  PIR_MASKED: '4',
  DC_SUBSTITUTION: '5',
  SENSOR_MISSING: '6',
  OFFLINE: '7',
});

/** Zone status (pyspcwebgw ZoneStatus). */
export const ZONE_STATUS = Object.freeze({
  OK: '0',
  INHIBIT: '1',
  ISOLATE: '2',
  SOAK: '3',
  TAMPER: '4',
  ALARM: '5',
  OK_NOT_RECENT: '6',
  TROUBLE: '7',
});

/**
 * Zone types (pyspcwebgw ZoneType) -> how the zone shows in Gladys, unless
 * the configuration says otherwise. As the Home Assistant integration: an
 * "alarm" zone is a motion detector, an entry/exit zone a door. Unknown or
 * technical types: a plain input. Unused zones (12) are not devices.
 */
export const ZONE_KIND_OF_TYPE = Object.freeze({
  0: 'motion',
  1: 'opening',
  2: 'opening',
  3: 'smoke',
  4: 'smoke',
  24: 'leak',
  30: 'opening',
});
export const UNUSED_ZONE_TYPE = '12';

/** How a zone may show in Gladys (frozen: also its feature key). */
export const ZONE_KINDS = Object.freeze(['opening', 'motion', 'smoke', 'leak', 'input']);

/** SIA codes of the websocket that concern an area or a zone (pyspcwebgw). */
export const SIA = Object.freeze({
  AREA: new Set(['CG', 'NL', 'OG', 'BV']),
  ZONE: new Set(['ZO', 'ZC', 'ZX', 'ZD', 'ZM', 'BA', 'BB', 'BU', 'BR', 'BC']),
  /** Some firmwares report a mode change with the user only: every area is read. */
  ALL_AREAS: new Set(['CL', 'OP']),
  /** A verified alarm of the area. */
  VERIFIED_ALARM: 'BV',
  /** Someone set or unset at the panel: a set of Gladys never sent again after it. */
  MOVES: new Set(['CG', 'NL', 'OG', 'CL', 'OP']),
  /** Of those, the unsets (the others are sets). */
  UNSETS: new Set(['OG', 'OP']),
});

/** Gladys core values (server/utils/constants.js). */
export const OPENING_SENSOR_STATE = Object.freeze({ OPEN: 0, CLOSE: 1 });
export const BUTTON_PUSH = Object.freeze({ PRESSED: 1 });

/** Protection of each mode: an arm never lowers it (part sets are not comparable). */
export const PROTECTION = Object.freeze({ unset: 0, part_set_a: 1, part_set_b: 1, full_set: 2 });

export const LIMITS = Object.freeze({
  /** Areas and zones taken from the gateway (an SPC6300 has 60 areas, 512 zones). */
  maxAreas: 64,
  maxZones: 1024,
  /** Bytes of an answer of the gateway (512 zones are about 120 KB). */
  maxBody: 1024 * 1024,
  /** Bytes of a websocket message (a SIA event is about 300 bytes). */
  maxMessage: 16 * 1024,
  /** Characters kept of a name of the panel. */
  maxName: 64,
  /** Ids of areas and zones: digits only, this many at most. */
  maxIdDigits: 4,
  /** Area or zone reads asked by events waiting at once; more: everything is read. */
  maxDirty: 32,
  /** Websocket messages per minute; more: the socket is closed (a flood), reads go on. */
  wsMessagesPerMinute: 600,
  /** Disarms per area within a minute (never a limit on the arms). */
  disarmsPerMinute: 6,
  /** Times an arm not applied is sent again (the request that never left included). */
  armResends: 3,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Part of it only the panel and the areas may use. */
  priorityStates: 60,
  /** Entries per publishTransports call (the SDK refuses more). */
  transportsPerCall: 100,
});

export const TIMINGS = Object.freeze({
  /** The areas and zones are read this often (the events come between). */
  poll: 60_000,
  /** A read of the gateway (one request). */
  readTimeout: 10_000,
  /** Failed reads: the next one after this, doubled up to retryMax. */
  retryMin: 30_000,
  retryMax: 5 * 60_000,
  /** /data unreadable: tried again this often. */
  dataRetry: 60_000,
  /** getConfig() failed: asked again after this, doubled up to configRetryMax. */
  configRetryMin: 30_000,
  configRetryMax: 10 * 60_000,
  /** Values older than this are not published (a read every minute). */
  fresh: 150_000,
  /** The websocket: handshake, reconnection waits, ping. */
  wsHandshake: 5_000,
  wsRetry: [15_000, 30_000, 60_000, 120_000, 300_000],
  wsPing: 30_000,
  /** No pong nor message for this long: the socket is dead. */
  wsDead: 75_000,
  /** Reads asked by events: at most one per this much. */
  eventGap: 250,
  /**
   * Gladys waits 5 s for a set_value answer. From the moment a command
   * arrives: its fresh read by readBy (disarm), its request on the wire by
   * sendBy (else refused, nothing sent), the gateway's answer and the read
   * that confirms it by answerBy, the answer to Gladys by ackBy.
   */
  readBy: 2_500,
  sendBy: 3_500,
  answerBy: 4_300,
  /** An arm whose request did not leave is tried again this often within sendBy. */
  armRetry: 250,
  /** A read of the gateway with no byte for this long is cut when an arm comes. */
  frozenRead: 1_000,
  /** A part set reads the area first, by this much (it must not lower a full set). */
  partReadBy: 1_200,
  /** After an arm or a disarm: the area is read again at these delays (from its answer). */
  followUps: [5_000, 20_000, 60_000],
  /** A set that never reached the gateway may be sent again this long after the press. */
  guardLife: 2 * 60_000,
  /** A notice about a set in the status is dropped after this. */
  noticeLife: 60 * 60_000,
  /** "Test the connection" answers within this (the manifest allows 30 s). */
  testBudget: 25_000,
  /** At most one read for the "Test the connection" button per this much. */
  testGap: 10_000,
  /** The time of the last read is written to /data at most this often. */
  attemptWrite: 60_000,
});
