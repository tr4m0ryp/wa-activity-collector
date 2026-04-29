import { initDb, closeDb } from './db/db.js';
import { AccountManager } from './wa/manager.js';
import { startServer } from './server/server.js';
import { Watchdog } from './health/watchdog.js';

async function main() {
  initDb();
  const manager = new AccountManager();
  startServer(manager);
  await manager.startAll();
  const watchdog = new Watchdog(manager);
  watchdog.start();

  const shutdown = async () => {
    console.log('shutting down...');
    watchdog.stop();
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
