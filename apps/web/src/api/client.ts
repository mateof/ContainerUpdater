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
  MetricsSnapshot,
  RegistryConfig,
  TelegramUser,
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

export interface UpdatePlan {
  strategy: UpdateStrategy;
  containerId: string | null;
  containerName: string | null;
  serviceName: string | null;
  projectKey: string | null;
  reason: string | null;
}

export const api = {
  authStatus: () => get<{ needsSetup: boolean; defaultLocale: 'es' | 'en' }>('/auth/status'),
  setup: (input: { username: string; password: string; locale: string }) =>
    post<{ ok: true }>('/setup', input),
  login: (username: string, password: string) =>
    post<{ user: CurrentUser }>('/auth/login', { username, password }),
  logout: () => post<{ ok: true }>('/auth/logout'),
  me: () => get<{ user: CurrentUser }>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: true }>('/auth/password', { currentPassword, newPassword }),
  updateProfile: (locale: string) => put<{ user: CurrentUser }>('/auth/profile', { locale }),

  status: () => get<SystemStatusResponse>('/status'),
  containers: () => get<{ containers: ContainerSummary[] }>('/containers'),
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

  applyProject: (key: string, restartOnly: boolean) =>
    post<{ ok: true }>(`/projects/${encodeRef(key)}/apply`, { restartOnly }),

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
