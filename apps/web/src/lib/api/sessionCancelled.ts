// Kept apart from client.ts so a screen's catch block can recognise a cancelled
// request without importing the HTTP client (which tests routinely mock).

/**
 * Thrown by the API client (and by switchShop) in exactly these cases:
 *  - the session a request started under has ended — logout, login as someone
 *    else, switch-shop, or a forced sign-out — before its answer arrived;
 *  - a scoped request (or refresh) is attempted while a logout is in flight.
 * In the first case the request may have reached the server and even succeeded
 * there; the client just no longer has anyone to hand the result to.
 *
 * Callers MUST swallow it: no error message, no toast, no failed-state, no
 * setState. Catch blocks that render failures start with
 * `if (isSessionCancelled(err)) return;`. Showing "save failed" for a request
 * the server may have completed is what makes staff re-enter the same car.
 */
export class SessionCancelledError extends Error {
  constructor() {
    super('session_cancelled');
    this.name = 'SessionCancelledError';
  }
}

export function isSessionCancelled(err: unknown): boolean {
  return err instanceof SessionCancelledError;
}
