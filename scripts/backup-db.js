import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required. Configure it in the environment; no credentials are printed.');
  process.exit(1);
}
let hostname = '';
try { hostname = new URL(connectionString).hostname; } catch {}
const pool = new pg.Pool({
  connectionString,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(hostname) || process.env.PGSSL_MODE === 'disable'
    ? false
    : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' },
  max: 1
});

try {
  const listed = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
  );
  const backup = { createdAt: new Date().toISOString(), schema: 'public', tables: {} };
  for (const row of listed.rows) {
    const table = String(row.table_name);
    const quoted = '"' + table.replace(/"/g, '""') + '"';
    const data = await pool.query('SELECT * FROM public.' + quoted);
    backup.tables[table] = data.rows;
  }
  const directory = path.resolve(process.env.BACKUP_DIR || 'backups');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = backup.createdAt.replace(/[:.]/g, '-');
  const filename = 'aki-db-' + stamp + '.json.gz';
  const archive = gzipSync(Buffer.from(JSON.stringify(backup), 'utf8'), { level: 9 });
  await fs.writeFile(path.join(directory, filename), archive, { flag: 'wx', mode: 0o600 });
  console.log('Database export created:', path.relative(process.cwd(), path.join(directory, filename)), '(' + archive.length + ' bytes)');
} catch (error) {
  console.error('Database backup failed:', error?.message || 'unknown error');
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
