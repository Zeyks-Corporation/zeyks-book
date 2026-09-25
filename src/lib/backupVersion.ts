/**
 * Version stamped into an exported backup and checked on restore.
 *
 * This is the only thing the old `storage.ts` module still had to offer: the
 * books themselves live in Firestore now, so there is no browser key/value
 * layer left to version.
 */
export const BACKUP_SCHEMA_VERSION = 2;
