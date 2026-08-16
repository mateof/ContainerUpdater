import type { Db } from '../index.js';
import type { Keyring } from '../../crypto/keyring.js';
import { createUserRepository, createSessionRepository } from './users.js';
import { createInventoryRepository } from './inventory.js';
import { createHistoryRepository } from './history.js';
import { createRegistryRepository } from './registries.js';
import { createNotificationRepository, createTelegramRepository } from './notifications.js';
import { createSettingsRepository, createTagCacheRepository } from './settings.js';
import { createManagedProjectRepository } from './projects.js';
import { createPasskeyRepository } from './passkeys.js';

export function createRepositories(db: Db, keyring: Keyring) {
  return {
    users: createUserRepository(db),
    sessions: createSessionRepository(db),
    inventory: createInventoryRepository(db),
    managedProjects: createManagedProjectRepository(db, keyring),
    passkeys: createPasskeyRepository(db),
    history: createHistoryRepository(db),
    registries: createRegistryRepository(db, keyring),
    notifications: createNotificationRepository(db),
    telegram: createTelegramRepository(db),
    settings: createSettingsRepository(db),
    tagCache: createTagCacheRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

export { DEFAULT_POLICY } from './inventory.js';
export { dedupeKey } from './notifications.js';
export type { ImageRow, ProjectRow } from './inventory.js';
export type { ManagedProjectRow, ProjectFileKind, ProjectFileVersion } from './projects.js';
export type { UserRow } from './users.js';
export type { PasskeyRow } from './passkeys.js';
export type { RegistryCredentials } from './registries.js';
