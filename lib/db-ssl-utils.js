const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DATABASE_SSL_MODES = new Set(['auto', 'disable', 'require', 'verify-full']);

function explicitVerificationOverride(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function resolveDatabaseSsl({
  host = '',
  isRender = false,
  mode = 'auto',
  rejectUnauthorized
} = {}) {
  const normalizedHost = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const normalizedMode = String(mode || 'auto').trim().toLowerCase();
  if (!DATABASE_SSL_MODES.has(normalizedMode)) {
    throw new RangeError('PGSSL_MODE must be one of: auto, disable, require, verify-full.');
  }

  const verifyOverride = explicitVerificationOverride(rejectUnauthorized);

  // Local database development does not need TLS unless explicitly required.
  if (normalizedMode === 'auto' && LOCAL_DATABASE_HOSTS.has(normalizedHost)) return false;

  // Explicit mode always wins. "require" encrypts the connection but, like PostgreSQL
  // sslmode=require, does not validate a self-signed certificate unless overridden.
  if (normalizedMode === 'disable') return false;
  if (normalizedMode === 'require') {
    return { rejectUnauthorized: verifyOverride ?? false };
  }
  if (normalizedMode === 'verify-full') {
    return { rejectUnauthorized: true };
  }

  // Render Blueprints provide the internal Postgres URL through fromDatabase.connectionString.
  // Render internal Postgres hosts use the short dpg-* hostname, and TLS is optional on the
  // private network. Do not disable TLS for external Render hosts or third-party databases.
  const isRenderInternalPostgresHost = /^dpg-[a-z0-9-]+$/.test(normalizedHost);
  if (isRender === true && isRenderInternalPostgresHost && verifyOverride === undefined) {
    return false;
  }

  // Keep strict certificate verification for external Render Postgres and other databases.
  // Retain the legacy explicit override for deployments that have already configured it.
  return { rejectUnauthorized: verifyOverride ?? true };
}
