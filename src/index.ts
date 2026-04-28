import { initDb, closeDb } from './db/db.js';
import { AccountManager } from './wa/manager.js';
import { startServer } from './server/server.js';

async function main() {
  initDb();
  const manager = new AccountManager();
  startServer(manager);
  await manager.startAll();

  const shutdown = async () => {
    console.log('shutting down...');
    await manager.shutdown();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
