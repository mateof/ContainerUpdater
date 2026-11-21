import {
  DEFAULT_HEALTHCHECK_INTERVAL_SECONDS,
  type HealthcheckInfo,
  type HealthcheckSource,
  type LoggingRule,
  type LoggingWarning,
  type StoredRule,
  type TuningRule,
} from '@cu/shared';
import type { CreateContainerBody, HealthcheckConfig } from '../../docker/types.js';
import { parseImageReference } from '../../registry/reference.js';

const NS = 1e9;

export function fromDockerHealthcheck(config: HealthcheckConfig | null | undefined): HealthcheckInfo | 'disabled' | null {
  if (!config) return null;
  const test = config.Test && config.Test.length > 0 ? config.Test : null;
  if (test?.[0] === 'NONE') return 'disabled';
  const seconds = (value: number | undefined): number | null => (value && value > 0 ? value / NS : null);
  return {
    test,
    intervalSeconds: seconds(config.Interval),
    timeoutSeconds: seconds(config.Timeout),
    retries: config.Retries && config.Retries > 0 ? config.Retries : null,
    startPeriodSeconds: seconds(config.StartPeriod),
  };
}

export function isActive(info: HealthcheckInfo | 'disabled' | null): info is HealthcheckInfo {
  return info !== null && info !== 'disabled' && info.test !== null && info.test.length > 0;
}

export function probesPerMinute(info: HealthcheckInfo | 'disabled' | null): number | null {
  if (!isActive(info)) return null;
  return 60 / (info.intervalSeconds ?? DEFAULT_HEALTHCHECK_INTERVAL_SECONDS);
}

function sameInfo(a: HealthcheckInfo, b: HealthcheckInfo): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function healthcheckSource(input: {
  effective: HealthcheckInfo | 'disabled' | null;
  image: HealthcheckInfo | 'disabled' | null;
  compose: HealthcheckInfo | 'disabled' | null | undefined;
}): HealthcheckSource {
  if (input.effective === 'disabled') return 'disabled';
  if (!isActive(input.effective)) return 'none';
  if (input.compose && input.compose !== 'disabled') return 'compose';
  if (input.compose === undefined && isActive(input.image) && !sameInfo(input.effective, input.image)) {
    return 'container';
  }
  if (isActive(input.image)) return 'image';
  return input.compose === undefined ? 'container' : 'image';
}

export function imageKeyOf(imageRef: string | null): string | null {
  if (!imageRef) return null;
  try {
    const ref = parseImageReference(imageRef);
    return `${ref.host}/${ref.repository}`;
  } catch {
    return null;
  }
}

export function effectiveRule(
  rules: StoredRule[],
  containerName: string,
  imageKey: string | null,
): StoredRule | null {
  return (
    rules.find((rule) => rule.scope === 'container' && rule.key === containerName) ??
    (imageKey ? rules.find((rule) => rule.scope === 'image' && rule.key === imageKey) : undefined) ??
    null
  );
}

export function loggingWarning(driver: string, options: Record<string, string>): LoggingWarning | null {
  if (driver === 'db') return 'db-driver';
  if (driver === 'json-file' && !options['max-size']) return 'no-rotation';
  return null;
}

export function healthcheckMatches(rule: TuningRule['healthcheck'], effective: HealthcheckInfo | 'disabled' | null): boolean {
  if (!rule) return true;
  if (rule.mode === 'disable') return !isActive(effective);
  if (!isActive(effective)) return false;
  if ((effective.intervalSeconds ?? DEFAULT_HEALTHCHECK_INTERVAL_SECONDS) !== rule.intervalSeconds) return false;
  if (rule.timeoutSeconds !== null && effective.timeoutSeconds !== rule.timeoutSeconds) return false;
  if (rule.retries !== null && effective.retries !== rule.retries) return false;
  if (rule.startPeriodSeconds !== null && (effective.startPeriodSeconds ?? 0) !== rule.startPeriodSeconds) return false;
  if (rule.command !== null) {
    const test = effective.test ?? [];
    return test[0] === 'CMD-SHELL' && test[1] === rule.command;
  }
  return true;
}

export function loggingMatches(
  rule: LoggingRule | null,
  effective: (LoggingRule & { optionsKnown?: boolean }) | null,
): boolean {
  if (!rule) return true;
  if (!effective || effective.driver !== rule.driver) return false;
  if (effective.optionsKnown === false) return true;
  return Object.entries(rule.options).every(([key, value]) => effective.options[key] === value);
}

export function ruleDifferences(
  rule: TuningRule,
  healthcheck: HealthcheckInfo | 'disabled' | null,
  logging: (LoggingRule & { optionsKnown?: boolean }) | null,
): Array<'healthcheck' | 'logging'> {
  const differs: Array<'healthcheck' | 'logging'> = [];
  if (!healthcheckMatches(rule.healthcheck, healthcheck)) differs.push('healthcheck');
  if (!loggingMatches(rule.logging, logging)) differs.push('logging');
  return differs;
}

export function applyRuleToBody(
  body: CreateContainerBody,
  rule: TuningRule,
  current: HealthcheckConfig | null | undefined,
): CreateContainerBody {
  const next: CreateContainerBody = { ...body, HostConfig: { ...body.HostConfig } };
  if (rule.healthcheck?.mode === 'disable') {
    next.Healthcheck = { Test: ['NONE'] };
  } else if (rule.healthcheck?.mode === 'set') {
    const healthcheck = rule.healthcheck;
    const keep = current && current.Test?.[0] !== 'NONE' ? current : {};
    next.Healthcheck = {
      Test: healthcheck.command ? ['CMD-SHELL', healthcheck.command] : keep.Test,
      Interval: healthcheck.intervalSeconds * NS,
      Timeout: healthcheck.timeoutSeconds !== null ? healthcheck.timeoutSeconds * NS : keep.Timeout,
      Retries: healthcheck.retries ?? keep.Retries,
      StartPeriod: healthcheck.startPeriodSeconds !== null ? healthcheck.startPeriodSeconds * NS : keep.StartPeriod,
    };
  }
  if (rule.logging) {
    next.HostConfig = { ...next.HostConfig, LogConfig: { Type: rule.logging.driver, Config: { ...rule.logging.options } } };
  }
  return next;
}

export function needsCommand(rule: TuningRule, current: HealthcheckInfo | 'disabled' | null, image: HealthcheckInfo | 'disabled' | null): boolean {
  if (rule.healthcheck?.mode !== 'set' || rule.healthcheck.command) return false;
  return !isActive(current) && !isActive(image);
}
