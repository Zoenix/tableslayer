/**
 * Production entrypoint for self-hosted Table Slayer.
 *
 * 0. Refuses to start if /data isn't mounted from the host (data would be lost)
 * 1. Backs up the database, then applies migrations (local SQLite or Turso)
 * 2. Mirrors static assets into local storage in the background
 * 3. Serves the SvelteKit app and forwards realtime websockets (/parties/*)
 *    to the realtime container, so browsers only ever talk to one origin
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { downloadStaticAssets } from '../scripts/assets-download.js';
import { assertPersistentDataRoot, backupDatabase } from './dataSafety.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const realtimeUrl = new URL(process.env.REALTIME_INTERNAL_URL || 'http://localhost:1999');
const dataRoot = process.env.DATA_ROOT || '/data';

const runMigrations = async () => {
  const url = (process.env.TURSO_APP_DB_URL ||= `file:${path.join(appDir, 'data/tableslayer.db')}`);
  if (url.startsWith('file:')) {
    fs.mkdirSync(path.dirname(path.resolve(url.slice('file:'.length))), { recursive: true });
  }
  const client = createClient({ url, authToken: process.env.TURSO_APP_DB_AUTH_TOKEN });
  if (url.startsWith('file:') && process.env.SKIP_DB_BACKUP !== 'true') {
    const dbFile = path.resolve(url.slice('file:'.length));
    const backup = await backupDatabase(client, dbFile, path.join(path.dirname(dbFile), 'backups'));
    if (backup) console.log(`🗄️  Database backed up to ${backup}`);
  }
  console.log('⏳ Applying database migrations...');
  await migrate(drizzle(client), { migrationsFolder: path.join(appDir, 'src/lib/db/app/migrations') });
  client.close();
  console.log('✅ Database migrations applied');
};

const syncAssets = () => {
  const storageDriver = process.env.STORAGE_DRIVER || 'local';
  if (storageDriver !== 'local' || process.env.SKIP_ASSET_DOWNLOAD === 'true') return;
  const root = process.env.LOCAL_STORAGE_PATH || path.join(appDir, 'data/files');
  downloadStaticAssets({ root, log: () => {} })
    .then(({ total, downloaded, failed }) => {
      console.log(`🖼️  Static assets: ${downloaded} downloaded, ${failed.length} failed, ${total} total`);
      if (failed.length) console.warn('   Missing assets will be retried on next start:', failed.join(', '));
    })
    .catch((error) => console.warn('⚠️ Static asset download failed:', error.message));
};

// Raw TCP pass-through of the websocket upgrade to the realtime worker
const proxyUpgrade = (req, socket, head) => {
  if (!req.url?.startsWith('/parties/')) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(Number(realtimeUrl.port) || 80, realtimeUrl.hostname, () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = name.toLowerCase() === 'host' ? realtimeUrl.host : req.rawHeaders[i + 1];
      raw += `${name}: ${value}\r\n`;
    }
    upstream.write(`${raw}\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', (error) => {
    console.warn('Realtime proxy error:', error.message);
    close();
  });
  socket.on('error', close);
  upstream.setNoDelay(true);
  socket.setNoDelay(true);
};

const usesDataRoot = [process.env.TURSO_APP_DB_URL?.replace(/^file:/, ''), process.env.LOCAL_STORAGE_PATH].some(
  (dir) => dir && path.resolve(dir).startsWith(path.resolve(dataRoot) + path.sep)
);
if (usesDataRoot) assertPersistentDataRoot(dataRoot);

if (process.env.SKIP_MIGRATIONS !== 'true') await runMigrations();
syncAssets();

// adapter-node assumes https unless told otherwise. Requests that reach us directly
// are plain http; a TLS-terminating reverse proxy sets X-Forwarded-Proto/Host.
// ORIGIN (optional) pins the public origin regardless of headers.
process.env.PROTOCOL_HEADER ||= 'x-forwarded-proto';
process.env.HOST_HEADER ||= 'x-forwarded-host';
const pinnedOrigin = process.env.ORIGIN ? new URL(process.env.ORIGIN) : null;
const protocolHeader = process.env.PROTOCOL_HEADER.toLowerCase();
const hostHeader = process.env.HOST_HEADER.toLowerCase();

const withOrigin = (req) => {
  if (pinnedOrigin) {
    req.headers[protocolHeader] = pinnedOrigin.protocol.slice(0, -1);
    req.headers[hostHeader] = pinnedOrigin.host;
  } else if (!req.headers[protocolHeader]) {
    req.headers[protocolHeader] = 'http';
  }
};

const { handler } = await import(path.join(appDir, 'build/handler.js'));
const server = http.createServer((req, res) => {
  withOrigin(req);
  handler(req, res);
});
server.on('upgrade', proxyUpgrade);
server.listen(port, host, () => {
  console.log(`🗡️  Table Slayer listening on http://${host}:${port} (realtime → ${realtimeUrl.origin})`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
