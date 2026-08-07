/**
 * Traduccion de estados a claves de i18n y a tonos de color.
 *
 * Se declaran como mapas explicitos en vez de construir la clave concatenando
 * trozos del estado: un estado nuevo con un guion en medio generaria una clave
 * inexistente y la interfaz mostraria el identificador crudo sin que nada falle
 * de forma visible. Con un mapa, TypeScript obliga a cubrir el caso.
 */
import type {
  ImageUsage,
  ContainerState,
  HealthState,
  JobStatus,
  UpdateStatus,
  UpdateStrategy,
} from '@cu/shared';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'updates.statusQueued',
  running: 'updates.statusRunning',
  success: 'updates.statusSuccess',
  failed: 'updates.statusFailed',
  'rolled-back': 'updates.statusRolledBack',
  skipped: 'updates.statusSkipped',
};

export const JOB_STATUS_TONE: Record<JobStatus, Tone> = {
  queued: 'neutral',
  running: 'info',
  success: 'ok',
  failed: 'danger',
  'rolled-back': 'warn',
  skipped: 'neutral',
};

export const UPDATE_STATUS_LABEL: Record<UpdateStatus, string> = {
  'up-to-date': 'images.statusUpToDate',
  'update-available': 'images.statusUpdateAvailable',
  unknown: 'images.statusUnknown',
  pinned: 'images.statusPinned',
  error: 'images.statusError',
};

export const UPDATE_STATUS_TONE: Record<UpdateStatus, Tone> = {
  'up-to-date': 'ok',
  'update-available': 'accent',
  unknown: 'neutral',
  pinned: 'info',
  error: 'danger',
};

export const CONTAINER_STATE_LABEL: Record<ContainerState, string> = {
  created: 'states.created',
  running: 'states.running',
  paused: 'states.paused',
  restarting: 'states.restarting',
  removing: 'states.removing',
  exited: 'states.exited',
  dead: 'states.dead',
};

export const CONTAINER_STATE_TONE: Record<ContainerState, Tone> = {
  created: 'neutral',
  running: 'ok',
  paused: 'warn',
  restarting: 'info',
  removing: 'warn',
  exited: 'neutral',
  dead: 'danger',
};

export const HEALTH_LABEL: Record<HealthState, string> = {
  healthy: 'states.healthy',
  unhealthy: 'states.unhealthy',
  starting: 'states.starting',
  none: 'states.none',
};

export const STRATEGY_LABEL: Record<UpdateStrategy, string> = {
  compose: 'projects.strategyCompose',
  recreate: 'projects.strategyRecreate',
  unsupported: 'projects.strategyUnsupported',
};

export const STRATEGY_HELP: Record<UpdateStrategy, string> = {
  compose: 'projects.strategyComposeHelp',
  recreate: 'projects.strategyRecreateHelp',
  unsupported: 'projects.strategyUnsupportedHelp',
};

export const STRATEGY_TONE: Record<UpdateStrategy, Tone> = {
  compose: 'ok',
  recreate: 'info',
  unsupported: 'warn',
};

/**
 * Estado de uso de una imagen.
 *
 * Se muestra solo cuando NO esta en marcha: que una imagen este en uso es lo
 * normal, y una etiqueta en cada fila para decir lo esperable es ruido. Lo que
 * interesa senalar es lo que se puede limpiar.
 */
export const IMAGE_USAGE_LABEL: Record<ImageUsage, string> = {
  running: 'images.usageRunning',
  stopped: 'images.usageStopped',
  orphan: 'images.usageOrphan',
};

export const IMAGE_USAGE_TONE: Record<ImageUsage, Tone> = {
  running: 'ok',
  stopped: 'warn',
  orphan: 'neutral',
};
