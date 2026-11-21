import { z } from 'zod';
import type { ContainerState } from './types.js';

export type HealthcheckSource = 'compose' | 'container' | 'image' | 'disabled' | 'none';

export interface HealthcheckInfo {
  test: string[] | null;
  intervalSeconds: number | null;
  timeoutSeconds: number | null;
  retries: number | null;
  startPeriodSeconds: number | null;
}

export const DEFAULT_HEALTHCHECK_INTERVAL_SECONDS = 30;
export const SHORT_HEALTHCHECK_SECONDS = 60;

export type HealthcheckRule =
  | { mode: 'disable' }
  | {
      mode: 'set';
      command: string | null;
      intervalSeconds: number;
      timeoutSeconds: number | null;
      retries: number | null;
      startPeriodSeconds: number | null;
    };

export interface LoggingRule {
  driver: string;
  options: Record<string, string>;
}

export interface TuningRule {
  healthcheck: HealthcheckRule | null;
  logging: LoggingRule | null;
}

export type RuleScope = 'image' | 'container';

export interface StoredRule extends TuningRule {
  scope: RuleScope;
  key: string;
  updatedAt: number;
}

export type ApplyMode = 'compose' | 'recreate' | 'unsupported';

export type RuleStatus = 'ok' | 'pending-recreate' | 'not-applied';

export type LoggingWarning = 'no-rotation' | 'db-driver';

export interface ContainerTuningRow {
  id: string;
  name: string;
  image: string;
  imageKey: string | null;
  projectKey: string | null;
  projectName: string | null;
  serviceName: string | null;
  state: ContainerState;
  isSelf: boolean;
  healthcheck: {
    source: HealthcheckSource;
    effective: HealthcheckInfo | null;
    image: HealthcheckInfo | null;
    compose: HealthcheckInfo | 'disabled' | null;
    probesPerMinute: number | null;
    withoutCompose: HealthcheckInfo | null;
  };
  logging: {
    driver: string;
    options: Record<string, string>;
    optionsKnown: boolean;
    fromCompose: boolean;
    warning: LoggingWarning | null;
  };
  rule: { scope: RuleScope; key: string; status: RuleStatus; differs: Array<'healthcheck' | 'logging'> } | null;
  apply: { mode: ApplyMode; reason: string | null };
}

export interface DiskHealthOverview {
  containers: ContainerTuningRow[];
  rules: StoredRule[];
  daemonLogDriver: string | null;
  probesPerMinute: number;
}

export type ApplyOutcome =
  | 'written'
  | 'queued'
  | 'pending-recreate'
  | 'pending-update'
  | 'unchanged'
  | 'no-rule'
  | 'error';

export interface ApplyResult {
  containerId: string;
  name: string;
  outcome: ApplyOutcome;
  running: boolean;
  message: string | null;
  jobId: number | null;
}

export interface MountReport {
  mountPoint: string;
  source: string;
  fsType: string;
  atime: 'noatime' | 'relatime' | 'strictatime' | 'lazytime';
  commitSeconds: number | null;
  defaultCommitSeconds: number | null;
  flags: string[];
  advice: Array<'atime' | 'autodefrag' | 'discard' | 'commit'>;
}

export interface LogRate {
  containerId: string;
  name: string;
  driver: string;
  bytesPerMinute: number | null;
  linesPerMinute: number | null;
  error: string | null;
}

export interface LogRatesResponse {
  minutes: number;
  measuredAt: number;
  rates: LogRate[];
}

export type ImpactState = 'running' | 'done' | 'cancelled' | 'failed' | 'aborted';

export interface ImpactDiskResult {
  disk: string;
  baselineBps: number;
  pausedBps: number;
  noiseBps: number;
  significant: boolean;
}

export interface ImpactProbe {
  id: number;
  containerId: string;
  containerName: string;
  minutes: number;
  state: ImpactState;
  startedAt: number;
  endsAt: number;
  finishedAt: number | null;
  error: string | null;
  disks: ImpactDiskResult[];
}

const durationSeconds = z.number().int().min(1).max(86_400);

export const healthcheckRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('disable') }),
  z.object({
    mode: z.literal('set'),
    command: z.string().trim().min(1).max(1000).nullable(),
    intervalSeconds: durationSeconds,
    timeoutSeconds: durationSeconds.nullable(),
    retries: z.number().int().min(1).max(100).nullable(),
    startPeriodSeconds: z.number().int().min(0).max(86_400).nullable(),
  }),
]);

const LOG_OPTION_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;

export const loggingRuleSchema = z.object({
  driver: z.string().regex(/^[a-z][a-z0-9_.-]{0,31}$/),
  options: z
    .record(z.string().regex(LOG_OPTION_KEY), z.string().max(256))
    .refine((value) => Object.keys(value).length <= 20),
});

export const tuningRuleSchema = z
  .object({
    healthcheck: healthcheckRuleSchema.nullable(),
    logging: loggingRuleSchema.nullable(),
  })
  .refine((value) => value.healthcheck !== null || value.logging !== null, { message: 'empty-rule' });

export const ruleKeySchema = z.object({
  scope: z.enum(['image', 'container']),
  key: z.string().min(1).max(512),
});

export const saveRuleSchema = ruleKeySchema.extend({ rule: tuningRuleSchema });

export const saveContainerRulesSchema = z.object({
  containers: z.array(z.string().min(1).max(256)).min(1).max(200),
  rule: tuningRuleSchema,
});

export const applyTuningSchema = z.object({
  containerIds: z.array(z.string().regex(/^[a-f0-9]{12,64}$/)).min(1).max(200),
  recreate: z.boolean(),
});

export const logRatesSchema = z.object({
  minutes: z.number().int().min(1).max(60).default(10),
});

export const impactStartSchema = z.object({
  containerId: z.string().regex(/^[a-f0-9]{12,64}$/),
  minutes: z.number().int().min(2).max(15).default(5),
});

export function formatComposeDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours ? `${hours}h` : ''}${minutes ? `${minutes}m` : ''}${rest ? `${rest}s` : ''}`;
}
