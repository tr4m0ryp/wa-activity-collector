import { Server as IOServer } from 'socket.io';
import { AccountManager } from '../wa/manager.js';

export function wireSocketIO(io: IOServer, manager: AccountManager) {
  manager.on('account:status', (payload) => io.emit('account:status', payload));
  manager.on('account:qr', (payload) => io.emit('account:qr', payload));
  manager.on('probe', (payload) => io.emit('probe', payload));
  manager.on('presence', (payload) => io.emit('presence', payload));

  io.on('connection', (socket) => {
    socket.emit('hello', { ts: Date.now() });
  });
}
