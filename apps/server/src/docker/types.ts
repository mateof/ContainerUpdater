/**
 * Formas de la API de Docker que realmente usamos.
 *
 * Se declara solo lo que se lee, con casi todo opcional: Podman y los dockerd
 * antiguos de Synology omiten campos que la documentacion da por seguros, y un
 * tipo demasiado optimista se traduce en excepciones en tiempo de ejecucion.
 */

export interface ContainerListItem {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Command?: string;
  Created: number;
  State: string;
  Status: string;
  Labels?: Record<string, string>;
  Ports?: Array<{ IP?: string; PrivatePort: number; PublicPort?: number; Type: string }>;
  NetworkSettings?: { Networks?: Record<string, NetworkAttachment> };
  Mounts?: MountPoint[];
}

export interface NetworkAttachment {
  NetworkID?: string;
  EndpointID?: string;
  Aliases?: string[] | null;
  IPAddress?: string;
  IPAMConfig?: { IPv4Address?: string; IPv6Address?: string } | null;
  Links?: string[] | null;
  DriverOpts?: Record<string, string> | null;
  MacAddress?: string;
}

export interface MountPoint {
  Type: 'bind' | 'volume' | 'tmpfs' | 'npipe' | 'cluster';
  Name?: string;
  Source: string;
  Destination: string;
  Driver?: string;
  Mode?: string;
  RW?: boolean;
  Propagation?: string;
}

export interface HealthcheckConfig {
  Test?: string[];
  Interval?: number;
  Timeout?: number;
  Retries?: number;
  StartPeriod?: number;
}

export interface ContainerConfig {
  Hostname?: string;
  Domainname?: string;
  User?: string;
  Env?: string[] | null;
  Cmd?: string[] | null;
  Entrypoint?: string[] | null;
  Image?: string;
  Labels?: Record<string, string> | null;
  WorkingDir?: string;
  Volumes?: Record<string, unknown> | null;
  ExposedPorts?: Record<string, unknown> | null;
  Healthcheck?: HealthcheckConfig | null;
  StopSignal?: string;
  StopTimeout?: number | null;
  Tty?: boolean;
  OpenStdin?: boolean;
  AttachStdin?: boolean;
  AttachStdout?: boolean;
  AttachStderr?: boolean;
}

export interface HostConfig {
  Binds?: string[] | null;
  Mounts?: MountPoint[] | null;
  PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>> | null;
  RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
  NetworkMode?: string;
  Privileged?: boolean;
  CapAdd?: string[] | null;
  CapDrop?: string[] | null;
  Devices?: Array<{ PathOnHost: string; PathInContainer: string; CgroupPermissions: string }> | null;
  DeviceRequests?: unknown[] | null;
  LogConfig?: { Type?: string; Config?: Record<string, string> };
  Ulimits?: Array<{ Name: string; Soft: number; Hard: number }> | null;
  Sysctls?: Record<string, string> | null;
  Memory?: number;
  MemorySwap?: number;
  MemoryReservation?: number;
  NanoCpus?: number;
  CpuShares?: number;
  CpusetCpus?: string;
  GroupAdd?: string[] | null;
  ExtraHosts?: string[] | null;
  Dns?: string[] | null;
  DnsSearch?: string[] | null;
  DnsOptions?: string[] | null;
  SecurityOpt?: string[] | null;
  Tmpfs?: Record<string, string> | null;
  ShmSize?: number;
  Runtime?: string;
  Init?: boolean | null;
  AutoRemove?: boolean;
  PidMode?: string;
  IpcMode?: string;
  UTSMode?: string;
  UsernsMode?: string;
  ReadonlyRootfs?: boolean;
  OomKillDisable?: boolean | null;
  Links?: string[] | null;
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Created: string;
  Image: string;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    Dead: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string; FailingStreak: number };
  };
  RestartCount: number;
  Config: ContainerConfig;
  HostConfig: HostConfig;
  NetworkSettings?: {
    Networks?: Record<string, NetworkAttachment>;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  Mounts?: MountPoint[];
}

export interface ImageListItem {
  Id: string;
  ParentId?: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created: number;
  Size: number;
  VirtualSize?: number;
  Labels?: Record<string, string> | null;
}

export interface ImageInspect {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created: string;
  Size: number;
  Architecture?: string;
  Os?: string;
  Variant?: string;
  Config?: ContainerConfig;
  ContainerConfig?: ContainerConfig;
}

export interface ContainerStats {
  read?: string;
  preread?: string;
  cpu_stats?: {
    cpu_usage?: {
      total_usage?: number;
      percpu_usage?: number[] | null;
      usage_in_kernelmode?: number;
      usage_in_usermode?: number;
    };
    system_cpu_usage?: number | null;
    online_cpus?: number | null;
  };
  precpu_stats?: ContainerStats['cpu_stats'];
  memory_stats?: {
    usage?: number;
    max_usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{ major: number; minor: number; op: string; value: number }> | null;
  };
  pids_stats?: { current?: number; limit?: number };
}

/** Cuerpo de POST /containers/create. */
export interface CreateContainerBody extends ContainerConfig {
  HostConfig?: HostConfig;
  NetworkingConfig?: { EndpointsConfig?: Record<string, NetworkAttachment> };
}

/**
 * Respuesta de `/system/df`.
 *
 * Los campos son opcionales a proposito: Docker y Podman no publican
 * exactamente lo mismo, y Podman deja fuera la cache de construccion en algunas
 * versiones. Ausente y cero son cosas distintas, y la interfaz lo dice.
 */
export interface SystemDf {
  LayersSize?: number;
  Images?: Array<{ Size?: number; Containers?: number }> | null;
  Containers?: Array<{ SizeRw?: number }> | null;
  Volumes?: VolumeListItem[] | null;
  BuildCache?: Array<{ Size?: number; InUse?: boolean; Shared?: boolean }> | null;
}

export interface VolumeListItem {
  Name: string;
  Driver?: string;
  Mountpoint?: string;
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
  Scope?: string;
  UsageData?: { Size?: number; RefCount?: number } | null;
}

/**
 * Un evento del daemon.
 *
 * Los campos van opcionales porque Docker y Podman no publican exactamente lo
 * mismo, y porque la forma cambio entre versiones de la API: `status` y `id`
 * son los nombres antiguos, `Action` y `Actor` los actuales. Se aceptan los dos.
 */
export interface DockerEvent {
  Type?: string;
  Action?: string;
  status?: string;
  id?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  time?: number;
}
