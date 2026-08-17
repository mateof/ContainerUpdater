/**
 * Cliente de la API.
 *
 * La sesion viaja en una cookie httpOnly, asi que aqui no hay ningun token que
 * guardar ni cabecera que anadir: solo `credentials: same-origin`.
 */
import type {
  AppSettings,
  CheckRun,
  ComposeProject,
  ContainerSummary,
  CurrentUser,
  ImagePolicy,
  Locale,
  MetricsSnapshot,
  PasskeySummary,
  PasskeySupport,
  ProjectAction,
  ProjectFiles,
  ProjectsDirInfo,
  RegistryConfig,
  ServiceAction,
  TelegramUser,
  TotpEnrollment,
  TotpStatus,
  TrackedImage,
  UpdateJob,
  UpdateStrategy,
} from '@cu/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly payload?: unknown,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/** Se dispara cuando el servidor responde 401 para que la app vuelva al login. */
export const onUnauthorized = { handler: null as null | (() => void) };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 401) {
    onUnauthorized.handler?.();
    throw new ApiError(401, 'unauthorized');
  }

  if (!response.ok) {
    let payload: unknown;
    let code = `http-${response.status}`;
    try {
      payload = await response.json();
      if (payload && typeof payload === 'object' && 'error' in payload) {
        code = String((payload as { error: unknown }).error);
      }
    } catch {
      // Respuesta sin cuerpo JSON: se queda el codigo generico.
    }
    throw new ApiError(response.status, code, payload);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/** Las referencias llevan `/` y `:`, asi que hay que codificarlas dos veces. */
const encodeRef = (ref: string) => encodeURIComponent(ref);

export interface SystemStatusResponse {
  version: string;
  keyringHealthy: boolean;
  keyringReason: string | null;
  dockerConnected: boolean;
  dockerApiVersion: string | null;
  dockerFlavor: string;
  selfContainerId: string | null;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  checkRunning: boolean;
  updateRunning: boolean;
  /** Trabajos esperando turno, sin contar el que se esta ejecutando. */
  updateQueued: number;
  currentJobId: number | null;
  updatesAvailable: number;
  telegram: { configured: boolean; running: boolean };
}

/**
 * Forma del `inspect` de Docker, solo con lo que muestra la interfaz.
 *
 * Todo opcional: los campos varian entre versiones del daemon y entre Docker y
 * Podman, y una pantalla de detalle no puede reventar porque falte uno.
 */
export interface ContainerInspectLike {
  Name?: string;
  Image?: string;
  Created?: string;
  RestartCount?: number;
  State?: {
    Status?: string;
    StartedAt?: string;
    Health?: { Status?: string; FailingStreak?: number };
  };
  Config?: {
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    Labels?: Record<string, string> | null;
    WorkingDir?: string;
    User?: string;
  };
  HostConfig?: {
    NetworkMode?: string;
    RestartPolicy?: { Name?: string };
  };
  NetworkSettings?: {
    Networks?: Record<
      string,
      { IPAddress?: string; MacAddress?: string; Aliases?: string[] | null }
    >;
  };
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
  }>;
}

/** Diagnostico del entorno: donde corre y que puede tocar. */
export interface RuntimeInfo {
  platform: { id: string; name: string; evidence: string | null; verified: boolean };
  runtime: {
    flavor: string;
    version: string | null;
    apiVersion: string | null;
    connected: boolean;
  };
  socket: { path: string; readable: boolean; detected: boolean };
  compose: {
    roots: string[];
    explicit: boolean;
    projectsFound: number;
    projectsUsable: number;
  };
  metrics: { hostProcPath: string | null; hostProcAvailable: boolean };
}

export interface UpdatePlan {
  strategy: UpdateStrategy;
  containerId: string | null;
  containerName: string | null;
  serviceName: string | null;
  projectKey: string | null;
  reason: string | null;
}

export const api = {
  authStatus: () => get<{ needsSetup: boolean; defaultLocale: Locale }>('/auth/status'),
  setup: (input: { username: string; password: string; locale: string }) =>
    post<{ ok: true }>('/setup', input),
  /**
   * Primer paso. Con segundo factor activo NO devuelve usuario sino un ticket:
   * la sesion se crea en `loginTotp`, no aqui.
   */
  login: (username: string, password: string) =>
    post<{ user: CurrentUser } | { needsTotp: true; ticket: string }>('/auth/login', {
      username,
      password,
    }),
  logout: () => post<{ ok: true }>('/auth/logout'),
  me: () => get<{ user: CurrentUser }>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: true }>('/auth/password', { currentPassword, newPassword }),
  updateProfile: (locale: string) => put<{ user: CurrentUser }>('/auth/profile', { locale }),

  /**
   * Si este origen admite passkeys, y si no, por que.
   *
   * La interfaz lo pregunta ANTES de ofrecer nada: un boton que revienta con un
   * error del navegador no explica que hace falta HTTPS con un nombre de
   * dominio, que es justo donde la gente se atasca.
   */
  /** Segundo factor: estado, alta, confirmacion y baja. */
  totpStatus: () => get<TotpStatus>('/auth/totp'),
  totpStart: () => post<TotpEnrollment>('/auth/totp/start'),
  totpConfirm: (code: string) => post<{ recoveryCodes: string[] }>('/auth/totp/confirm', { code }),
  totpDisable: (password: string) => post<{ ok: true }>('/auth/totp/disable', { password }),
  totpRegenerate: (password: string) =>
    post<{ recoveryCodes: string[] }>('/auth/totp/recovery', { password }),
  /** Segundo paso del login. Aqui es donde se crea la sesion. */
  loginTotp: (ticket: string, code: string) =>
    post<{ user: CurrentUser; usedRecovery: boolean; recoveryCodesLeft: number }>(
      '/auth/login/totp',
      { ticket, code },
    ),

  passkeySupport: () => get<PasskeySupport>('/auth/passkey/support'),
  passkeyRegisterOptions: () => post<Record<string, unknown>>('/auth/passkey/register/options'),
  passkeyRegisterVerify: (name: string, response: unknown) =>
    post<{ ok: true }>('/auth/passkey/register/verify', { name, response }),
  passkeyLoginOptions: () => post<Record<string, unknown>>('/auth/passkey/login/options'),
  passkeyLoginVerify: (response: unknown) =>
    post<{ user: CurrentUser }>('/auth/passkey/login/verify', { response }),
  passkeys: () => get<{ passkeys: PasskeySummary[] }>('/auth/passkeys'),
  deletePasskey: (id: number) => del<{ ok: true }>(`/auth/passkeys/${id}`),
  renamePasskey: (id: number, name: string) => put<{ ok: true }>(`/auth/passkeys/${id}`, { name }),

  status: () => get<SystemStatusResponse>('/status'),
  runtime: () => get<RuntimeInfo>('/runtime'),
  containers: () => get<{ containers: ContainerSummary[] }>('/containers'),
  /** Inspect completo del daemon. Tipado laxo a proposito: son decenas de campos. */
  container: (id: string) => get<{ container: ContainerInspectLike }>(`/containers/${id}`),
  containerLogs: (id: string, tail = 200) =>
    get<{ logs: string }>(`/containers/${id}/logs?tail=${tail}`),
  containerAction: (id: string, action: 'start' | 'stop' | 'restart') =>
    post<{ ok: true }>(`/containers/${id}/${action}`),

  images: () => get<{ images: TrackedImage[] }>('/images'),
  projects: () => get<{ projects: ComposeProject[] }>('/projects'),
  refreshInventory: () =>
    post<{ containers: ContainerSummary[]; images: TrackedImage[]; projects: ComposeProject[] }>(
      '/inventory/refresh',
    ),

  imagePlan: (ref: string) => get<{ plan: UpdatePlan }>(`/images/${encodeRef(ref)}/plan`),
  checkImage: (ref: string) => post<{ run: CheckRun }>(`/images/${encodeRef(ref)}/check`),
  savePolicy: (ref: string, patch: Partial<ImagePolicy>) =>
    put<{ policy: ImagePolicy }>(`/images/${encodeRef(ref)}/policy`, patch),
  /**
   * Borra la imagen local.
   *
   * `force` hace falta cuando quedan contenedores parados que la usan, y
   * borrarla los deja sin poder arrancar. El servidor responde 409 con la lista
   * de contenedores afectados si se pide sin forzar, para poder nombrarlos
   * antes de confirmar.
   */
  deleteImage: (ref: string, force: boolean) =>
    del<{ ok: true }>(`/images/${encodeRef(ref)}?force=${force ? 1 : 0}`),

  /** Devuelve 202 en cuanto encola: el progreso llega despues por SSE. */
  updateImage: (
    ref: string,
    body: {
      mode: 'update' | 'force';
      scope?: 'service' | 'project';
      removeImageFirst?: boolean;
      targetTag?: string;
    },
  ) => post<{ job: UpdateJob; queued: number }>(`/images/${encodeRef(ref)}/update`, body),

  /** Levantar, reiniciar o parar el proyecto entero. 202: corre en segundo plano. */
  projectAction: (projectKey: string, action: ProjectAction) =>
    post<{ job: UpdateJob; queued: number }>('/projects/action', { projectKey, action }),

  /** Si se pueden crear proyectos, y si no, por que no. */
  projectsDir: () => get<ProjectsDirInfo>('/projects/dir'),

  createProject: (body: { name: string; compose: string; env?: string; start: boolean }) =>
    post<{ name: string; dir: string; job: UpdateJob | null; startError?: string }>(
      '/projects/create',
      body,
    ),

  /**
   * Ficheros del proyecto, con los valores sensibles ya ocultos.
   *
   * Por POST porque la clave (nombre + directorio) va en el cuerpo: en la ruta,
   * las rutas largas de un NAS desbordan el limite y devuelven 414.
   */
  projectFiles: (projectKey: string) =>
    post<{ files: ProjectFiles }>('/projects/files/read', { projectKey }),

  /** El .env en texto plano. Se pide solo al entrar a editar, y queda auditado. */
  projectEnvRaw: (projectKey: string) =>
    post<{ content: string }>('/projects/files/env', { projectKey }),

  revealEnvValue: (projectKey: string, key: string) =>
    post<{ value: string }>('/projects/env/reveal', { projectKey, key }),

  saveProjectFiles: (body: {
    projectKey: string;
    compose: string;
    env?: string;
    apply: boolean;
  }) => put<{ ok: true; job: UpdateJob | null; applyError?: string }>('/projects/files', body),

  /** Deja de gestionarlo. NO borra nada del disco. */
  forgetProject: (projectKey: string) => post<{ ok: true }>('/projects/forget', { projectKey }),

  /** Accion de Compose sobre un servicio. Devuelve 202: corre en segundo plano. */
  serviceAction: (projectKey: string, serviceName: string, action: ServiceAction) =>
    post<{ job: UpdateJob; queued: number }>('/projects/service-action', {
      projectKey,
      serviceName,
      action,
    }),

  selfUpdatePlan: () =>
    get<{
      plan: {
        possible: boolean;
        strategy: UpdateStrategy;
        containerName: string | null;
        imageRef: string | null;
        warning: string | null;
        reason: string | null;
      };
    }>('/self-update/plan'),
  /** Tras esto el servidor se para en unos segundos: la interfaz debe reconectar. */
  selfUpdate: () => post<{ started: boolean; strategy: string }>('/self-update'),

  runCheck: () => post<{ started: boolean }>('/checks/run'),
  checkRuns: () => get<{ runs: CheckRun[] }>('/checks/runs'),
  jobs: () => get<{ jobs: UpdateJob[] }>('/updates/jobs'),
  job: (id: number) => get<{ job: UpdateJob }>(`/updates/jobs/${id}`),
  cancelJob: (id: number) => post<{ cancelled: true }>(`/updates/jobs/${id}/cancel`),
  retryJob: (id: number) => post<{ job: UpdateJob }>(`/updates/jobs/${id}/retry`),

  settings: () => get<{ settings: AppSettings }>('/settings'),
  saveSettings: (patch: Partial<AppSettings>) =>
    put<{ settings: AppSettings; nextCheckAt: number | null }>('/settings', patch),

  registries: () => get<{ registries: RegistryConfig[]; keyringHealthy: boolean }>('/registries'),
  createRegistry: (input: {
    name: string;
    host: string;
    authType: string;
    username?: string;
    secret?: string;
  }) => post<{ id: number }>('/registries', input),
  updateRegistry: (
    id: number,
    input: { name?: string; authType?: string; username?: string; secret?: string },
  ) => put<{ ok: true }>(`/registries/${id}`, input),
  deleteRegistry: (id: number) => del<{ ok: true }>(`/registries/${id}`),
  testRegistry: (id: number) => post<{ ok: true; testedWith: string }>(`/registries/${id}/test`),
  forgetSecrets: () => post<{ cleared: number }>('/registries/forget-secrets'),

  telegram: () =>
    get<{
      configured: boolean;
      running: boolean;
      botUsername: string | null;
      error: string | null;
      users: TelegramUser[];
    }>('/telegram'),
  telegramLinkCode: () =>
    post<{ code: string; expiresAt: number; deepLink: string | null }>('/telegram/link-code'),
  revokeTelegramUser: (id: number) => del<{ ok: true }>(`/telegram/users/${id}`),

  metrics: () => get<{ snapshot: MetricsSnapshot | null; history: MetricsSnapshot[] }>('/metrics/latest'),
};
