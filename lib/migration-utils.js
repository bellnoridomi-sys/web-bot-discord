export function isMigrationFilename(name) {
  return /^\d+_[a-z0-9_-]+\.sql$/i.test(String(name ?? ''));
}
