import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from './client';

// Relative: same-origin, same as client.ts — see apps/web/vite.config.ts for
// the dev proxy that makes this (and the httpOnly refresh cookie) work
// without CORS. VITE_SOCKET_URL is gone; an absolute cross-origin socket URL
// is exactly the split-origin setup that breaks SameSite=Strict.
const SOCKET_URL = '';

function createSocket(): Socket {
  return io(SOCKET_URL, {
    autoConnect: true,
    // A function, not a plain object: apps/api/src/lib/socket.ts disconnects
    // a socket the moment the access token it connected with expires, and
    // socket.io-client's own auto-reconnect logic re-invokes this on every
    // attempt — so reading getAccessToken() here (WO-004/T6 condition 1: the
    // in-memory holder in client.ts, never storage) means a reconnect after
    // an ordinary 401-triggered background refresh (client.ts) picks up the
    // new token by itself. A plain object would freeze in whatever token was
    // current at the first connection and silently fall back to the public
    // room on every reconnect after that.
    auth: (cb: (data: Record<string, unknown>) => void) => {
      const token = getAccessToken();
      cb(token ? { token } : {});
    },
  });
}

let socket: Socket = createSocket();

/** Every hook reaches the socket through here instead of importing a module-level
 * const directly, so it always sees the current connection after reconnectSocket(). */
export function getSocket(): Socket {
  return socket;
}

/** Tears down the current connection and opens a new one with whatever access
 * token is (or isn't) held in memory right now. Call this right after
 * setAccessToken() changes (i.e. from useAuth's login/switchShop/logout) so
 * the server re-evaluates room membership (`authed:{shopId}` vs `public`)
 * under the new identity instead of keeping the old one. */
export function reconnectSocket(): void {
  socket.disconnect();
  socket = createSocket();
}
