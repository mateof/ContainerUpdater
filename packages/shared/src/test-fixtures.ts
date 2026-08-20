import type { AppSettings, ImagePolicy } from './types.js';

/**
 * Valores base para las pruebas.
 *
 * Estan aqui y no repetidos en cada fichero de test para que anadir un campo a
 * `AppSettings` o a `ImagePolicy` rompa el typecheck en UN sitio y no en diez,
 * que es lo que hace que la gente acabe poniendo `as any` en los tests.
 */
export const DEFAULT_TEST_POLICY: ImagePolicy = {
  imageRef: 'registry-1.docker.io/library/nginx:alpine',
  autoUpdate: true,
  trackMode: 'digest',
  semverChannel: 'minor',
  notify: true,
  recreateScope: 'service',
  removeImageOnForce: false,
  cleanupOldImage: true,
  pausedUntil: null,
  ignoredDigest: null,
  minAgeHours: null,
};

export const DEFAULT_TEST_SETTINGS: AppSettings = {
  checkCron: '0 */6 * * *',
  autoUpdateEnabled: true,
  notifyOnUpdateAvailable: true,
  notifyOnUpdateApplied: true,
  notifyOnFailure: true,
  notifyOnContainerDown: true,
  notifyOnContainerRecovered: true,
  restartLoopThreshold: 3,
  defaultMinAgeHours: 24,
  serviceHost: '',
  maintenanceWindowEnabled: false,
  maintenanceStartHour: 4,
  maintenanceEndHour: 6,
  metricsIntervalSeconds: 5,
  metricsHistoryEnabled: false,
  historyRetentionDays: 30,
  registryConcurrency: 3,
  defaultLocale: 'es',
  allowTelegramGroups: false,
};
