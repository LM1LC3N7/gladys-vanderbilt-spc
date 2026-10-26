// -----------------------------------------------------------------------------
// GatewayError: every failure of a request to the SPC Web Gateway, with a code
// the app maps to a status, a retry policy or a message. Messages are built
// from codes and HTTP statuses only: never the text of an answer (it may echo
// a header), never a credential.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no TCP connection
  RESET: 'reset', // connection closed by the gateway
  TIMEOUT: 'timeout', // no answer in time
  NOT_SENT: 'not_sent', // the deadline passed before the connection was up: nothing left
  HTTP: 'http', // an HTTP status other than 200 (see `status`)
  BAD_ANSWER: 'bad_answer', // not the JSON expected
  TOO_LARGE: 'too_large', // answer above the size cap
  FAILED: 'failed', // the gateway answered `status` other than "success"
  AUTH_REQUIRED: 'auth_required', // 401 and no credentials configured
  AUTH_REFUSED: 'auth_refused', // 401 on fresh credentials: refused
  AUTH_UNSUPPORTED: 'auth_unsupported', // a 401 challenge we cannot answer
  CUT: 'cut', // aborted by us (an arm cut a frozen read, a new configuration)
});

export class GatewayError extends Error {
  constructor(code, message, { status, notSent = false } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    if (status !== undefined) this.status = status;
    /** True when no byte of the request can have reached the gateway. */
    this.notSent = notSent;
  }
}

export const isAuthError = (err) =>
  err?.code === CODES.AUTH_REFUSED ||
  err?.code === CODES.AUTH_REQUIRED ||
  err?.code === CODES.AUTH_UNSUPPORTED;
