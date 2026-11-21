import { isAlias, isMap, isScalar, isSeq, parseDocument, Scalar, YAMLMap, type Document } from 'yaml';
import { formatComposeDuration, type HealthcheckInfo, type LoggingRule, type TuningRule } from '@cu/shared';

export type ComposeEditReason =
  | 'invalid-yaml'
  | 'no-services'
  | 'service-not-found'
  | 'extends'
  | 'merge-key'
  | 'alias'
  | 'needs-command';

export class ComposeEditError extends Error {
  constructor(readonly reason: ComposeEditReason) {
    super(reason);
    this.name = 'ComposeEditError';
  }
}

export interface DeclaredService {
  healthcheck: HealthcheckInfo | 'disabled' | null;
  logging: LoggingRule | null;
}

const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001, us: 0.000001, ns: 1e-9 };

export function parseComposeDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const pattern = /(\d+(?:\.\d+)?)(h|ms|us|ns|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    total += Number(match[1]) * UNIT_SECONDS[match[2]!]!;
    consumed += match[0].length;
  }
  return consumed === text.length ? total : null;
}

function normalizeTest(value: unknown): string[] | null {
  if (typeof value === 'string') return value.trim() ? ['CMD-SHELL', value] : null;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value as string[];
  return null;
}

function serviceNode(doc: Document, service: string): YAMLMap {
  if (doc.errors.length > 0) throw new ComposeEditError('invalid-yaml');
  const services = doc.get('services', true);
  if (!isMap(services)) throw new ComposeEditError('no-services');
  const node = services.get(service, true);
  if (isAlias(node)) throw new ComposeEditError('alias');
  if (!isMap(node)) throw new ComposeEditError('service-not-found');
  return node;
}

export function readDeclaredService(text: string, service: string): DeclaredService {
  const doc = parseDocument(text);
  const node = serviceNode(doc, service);
  const plain = (node.toJS(doc, { maxAliasCount: 100 }) ?? {}) as Record<string, unknown>;

  let healthcheck: DeclaredService['healthcheck'] = null;
  const declared = plain.healthcheck as Record<string, unknown> | undefined;
  if (declared && typeof declared === 'object') {
    const test = normalizeTest(declared.test);
    if (declared.disable === true || test?.[0] === 'NONE') {
      healthcheck = 'disabled';
    } else {
      healthcheck = {
        test,
        intervalSeconds: parseComposeDuration(declared.interval),
        timeoutSeconds: parseComposeDuration(declared.timeout),
        retries: typeof declared.retries === 'number' ? declared.retries : null,
        startPeriodSeconds: parseComposeDuration(declared.start_period),
      };
    }
  }

  let logging: LoggingRule | null = null;
  const declaredLogging = plain.logging as Record<string, unknown> | undefined;
  if (declaredLogging && typeof declaredLogging === 'object') {
    const options: Record<string, string> = {};
    const rawOptions = declaredLogging.options;
    if (rawOptions && typeof rawOptions === 'object') {
      for (const [key, value] of Object.entries(rawOptions as Record<string, unknown>)) {
        if (value !== null && value !== undefined) options[key] = String(value);
      }
    }
    logging = {
      driver: typeof declaredLogging.driver === 'string' ? declaredLogging.driver : 'json-file',
      options,
    };
  }

  return { healthcheck, logging };
}

function quoted(value: string): Scalar {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

function hasMergeKey(node: YAMLMap): boolean {
  return node.items.some((pair) => isScalar(pair.key) && pair.key.value === '<<');
}

function hasExistingTest(node: YAMLMap): boolean {
  const current = node.get('healthcheck', true);
  if (!isMap(current)) return false;
  const test: unknown = current.get('test', true);
  if (isScalar(test)) return typeof test.value === 'string' && test.value.trim() !== '' && test.value !== 'NONE';
  if (isSeq(test)) {
    const items = test.items as unknown[];
    const first = items[0];
    return items.length > 0 && !(isScalar(first) && first.value === 'NONE');
  }
  return false;
}

export function applyRuleToService(
  text: string,
  service: string,
  rule: TuningRule,
  image: HealthcheckInfo | null,
): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  const node = serviceNode(doc, service);
  if (node.has('extends')) throw new ComposeEditError('extends');
  if (hasMergeKey(node)) throw new ComposeEditError('merge-key');
  if (isAlias(node.get('healthcheck', true)) || isAlias(node.get('logging', true))) {
    throw new ComposeEditError('alias');
  }

  if (rule.healthcheck?.mode === 'disable') {
    node.set('healthcheck', doc.createNode({ disable: true }));
  } else if (rule.healthcheck?.mode === 'set') {
    const healthcheck = rule.healthcheck;
    const keepsTest = hasExistingTest(node);
    const inherited = !healthcheck.command && !keepsTest ? image : null;
    if (!healthcheck.command && !keepsTest && !image?.test) throw new ComposeEditError('needs-command');
    const current = node.get('healthcheck', true);
    const target = isMap(current) ? current : new YAMLMap();
    target.delete('disable');
    if (!keepsTest) target.delete('test');
    const test = healthcheck.command ? ['CMD-SHELL', healthcheck.command] : inherited?.test;
    if (test) {
      target.delete('test');
      target.items.unshift(doc.createPair('test', doc.createNode(test, { flow: true })));
    }
    target.set('interval', formatComposeDuration(healthcheck.intervalSeconds));
    const timeout = healthcheck.timeoutSeconds ?? (target.has('timeout') ? null : (inherited?.timeoutSeconds ?? null));
    if (timeout !== null) target.set('timeout', formatComposeDuration(timeout));
    const retries = healthcheck.retries ?? (target.has('retries') ? null : (inherited?.retries ?? null));
    if (retries !== null) target.set('retries', retries);
    const startPeriod =
      healthcheck.startPeriodSeconds ?? (target.has('start_period') ? null : (inherited?.startPeriodSeconds ?? null));
    if (startPeriod !== null) target.set('start_period', formatComposeDuration(startPeriod));
    node.set('healthcheck', target);
  }

  if (rule.logging) {
    const logging = new YAMLMap();
    logging.set('driver', rule.logging.driver);
    const entries = Object.entries(rule.logging.options);
    if (entries.length > 0) {
      const options = new YAMLMap();
      for (const [key, value] of entries) options.set(key, quoted(value));
      logging.set('options', options);
    }
    node.set('logging', logging);
  }

  const next = doc.toString({ lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false, ...detectStyle(text) });
  return { text: next, changed: next !== text };
}

export function detectStyle(text: string): { indent: number; indentSeq: boolean } {
  const lines = text.split('\n');
  let indent = 0;
  let indentSeq = true;
  let sawSequence = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const previous = lines[index - 1]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const own = line.length - line.trimStart().length;
    const parent = previous.length - previous.trimStart().length;
    if (/:\s*(#.*)?$/.test(previous.trimEnd()) && !previous.trimStart().startsWith('#')) {
      if (line.trimStart().startsWith('- ')) {
        if (!sawSequence) {
          indentSeq = own > parent;
          sawSequence = true;
        }
      } else if (own > parent && indent === 0) {
        indent = own - parent;
      }
    }
  }
  return { indent: indent || 2, indentSeq };
}
