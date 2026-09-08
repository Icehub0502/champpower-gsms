import { io, type Socket } from 'socket.io-client';
import { TOKEN_KEY } from './client';

const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? '';

function createSocket(): Socket {
  const token = localStorage.getItem(TOKEN_KEY);
  return io(SOCKET_URL, {
    autoConnect: true,
    auth: token ? { token } : {},
    // Same ngrok free-tier workaround as the REST client (apps/web/src/lib/api/
    // client.ts) — harmless against a real backend, only needed so the polling
    // handshake isn't intercepted by ngrok's browser-warning interstitial.
    extraHeaders: { 'ngrok-skip-browser-warning': '1' },
  });
}

let socket: Socket = createSocket();

/** Every hook reaches the socket through here instead of importing a module-level
 * const directly, so it always sees the current connection after reconnectSocket(). */
export function getSocket(): Socket {
  return socket;
}

/** Tears down the current connection and opens a new one with whatever JWT is (or
 * isn't) in localStorage right now. Call this right after writing/clearing cp_token
 * (i.e. from useAuth's login/logout) so the server re-evaluates room membership
 * (`authed` vs `public`) under the new identity instead of keeping the old one. */
export function reconnectSocket(): void {
  socket.disconnect();
  socket = createSocket();
}
