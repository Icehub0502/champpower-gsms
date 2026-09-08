import type { Server as HttpServer } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import { verifyToken } from './jwt.js';

let io: SocketIoServer | undefined;

/**
 * One namespace, two rooms:
 * - `authed`: joined only by clients presenting a valid JWT on the handshake
 *   (`auth.token`). Staff-console pages listen here for full-row `*:changed` events.
 * - `public`: joined by anyone, no auth required — the /board and /lookup pages use
 *   this. Only ever receives refetch signals (`board:changed`, `lookup:changed`),
 *   never a raw row, so no PII can leak onto it by accident.
 */
export function initSocket(server: HttpServer): SocketIoServer {
  io = new SocketIoServer(server, {
    cors: { origin: process.env.CORS_ORIGIN || '*' },
  });

  io.on('connection', (socket) => {
    socket.join('public');
    const token = socket.handshake.auth?.token as string | undefined;
    if (token) {
      try {
        verifyToken(token);
        socket.join('authed');
      } catch {
        // invalid/expired token: leave the socket in `public` only.
      }
    }
  });

  return io;
}

export function getIo(): SocketIoServer {
  if (!io) throw new Error('socket.io not initialized');
  return io;
}

export function emitAuthed(event: string, payload: unknown): void {
  io?.to('authed').emit(event, payload);
}

export function emitPublic(event: string, payload?: unknown): void {
  io?.to('public').emit(event, payload);
}
