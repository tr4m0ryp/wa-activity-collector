import express from 'express';
import { createServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';
import { buildApiRouter } from './api.js';
import { wireSocketIO } from './ws.js';
import { AccountManager } from '../wa/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startServer(manager: AccountManager) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', buildApiRouter(manager));

  const uiDir = path.resolve(__dirname, '..', '..', 'ui');
  app.use(express.static(uiDir));

  const httpServer = createServer(app);
  const io = new IOServer(httpServer, {
    cors: { origin: '*' },
  });
  wireSocketIO(io, manager);

  httpServer.listen(CONFIG.HTTP_PORT, () => {
    console.log(`server listening on http://localhost:${CONFIG.HTTP_PORT}`);
  });

  return { httpServer, io };
}
