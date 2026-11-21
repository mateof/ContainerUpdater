import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ApplyResult,
  ComposeProject,
  ContainerSummary,
  ContainerTuningRow,
  DiskHealthOverview,
  HealthcheckInfo,
  LogRate,
  LogRatesResponse,
  LoggingRule,
  MountReport,
  RuleScope,
  StoredRule,
  TuningRule,
} from '@cu/shared';
import type { DockerApi } from '../../docker/api.js';
import type { ContainerInspect, ImageInspect } from '../../docker/types.js';
import type { ComposeRunner } from '../../docker/compose.js';
import type { ContainerRecreator } from '../../docker/recreate.js';
import type { Repositories } from '../../db/repositories/index.js';
import type { InventoryService } from '../inventory.js';
import type { ProjectFilesService } from '../project-files.js';
import type { UpdaterService } from '../updater.js';
import type { Logger } from '../../logger.js';
import { mapWithConcurrency } from '../checker.js';
import { parseMountinfo } from '../disk-io/system.js';
import { applyRuleToService, ComposeEditError, readDeclaredService, type DeclaredService } from './compose-edit.js';
import {
  effectiveRule,
  fromDockerHealthcheck,
  healthcheckMatches,
  healthcheckSource,
  imageKeyOf,
  isActive,
  loggingMatches,
  loggingWarning,
  probesPerMinute,
  ruleDifferences,
} from './model.js';

const DAEMON_INFO_TTL_MS = 10 * 60_000;

async function mapLimited<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  await mapWithConcurrency(
    items.map((item, index) => ({ item, index })),
    limit,
    async ({ item, index }) => {
      results[index] = await worker(item);
    },
  );
  return results;
}

interface Inspected {
  summary: ContainerSummary;
  inspect: ContainerInspect;
  image: ImageInspect | null;
  project: ComposeProject | null;
  declared: DeclaredService | null;
  composeText: string | null;
}

export class DiskHealthService {
  readonly #images = new Map<string, ImageInspect | null>();
  #daemonDriver: { value: string | null; at: number } | null = null;

  constructor(
    private readonly docker: DockerApi,
    private readonly inventory: InventoryService,
    private readonly repos: Repositories,
    private readonly projectFiles: ProjectFilesService,
    private readonly compose: ComposeRunner,
    private readonly recreator: ContainerRecreator,
    private readonly updater: UpdaterService,
    private readonly procPath: string | null,
    private readonly log: Logger,
  ) {}

  rules(): StoredRule[] {
    return this.repos.diskHealth.rules();
  }

  saveRule(scope: RuleScope, keys: string[], rule: TuningRule): void {
    this.repos.diskHealth.saveRules(scope, keys, rule);
  }

  deleteRule(scope: RuleScope, key: string): boolean {
    return this.repos.diskHealth.deleteRule(scope, key);
  }

  async overview(): Promise<DiskHealthOverview> {
    const daemonLogDriver = await this.#daemonLogDriver();
    const rules = this.rules();
    const inspected = await this.#inspectAll(this.inventory.snapshot.containers);
    const containers = inspected.map((entry) => this.#row(entry, rules, daemonLogDriver));
    const probes = containers.reduce((sum, row) => sum + (row.healthcheck.probesPerMinute ?? 0), 0);
    return { containers, rules, daemonLogDriver, probesPerMinute: Math.round(probes * 100) / 100 };
  }

  async mounts(): Promise<MountReport[] | null> {
    if (!this.procPath) return null;
    try {
      return parseMountinfo(await readFile(join(this.procPath, '1', 'mountinfo'), 'utf8'));
    } catch (error) {
      this.log.debug('No se puede leer mountinfo del host', error);
      return null;
    }
  }

  async logRates(minutes: number, now = Date.now()): Promise<LogRatesResponse> {
    const running = this.inventory.snapshot.containers.filter((container) => container.state === 'running');
    const rates: LogRate[] = await mapLimited(running, 4, async (container): Promise<LogRate> => {
      const inspect = await this.docker.inspectContainer(container.id).catch(() => null);
      const driver = inspect?.HostConfig.LogConfig?.Type ?? 'unknown';
      try {
        const volume = await this.docker.logVolumeSince(container.id, now / 1000 - minutes * 60, Boolean(inspect?.Config.Tty));
        return {
          containerId: container.id,
          name: container.name,
          driver,
          bytesPerMinute: volume.bytes / minutes,
          linesPerMinute: volume.lines / minutes,
          error: null,
        };
      } catch (error) {
        return {
          containerId: container.id,
          name: container.name,
          driver,
          bytesPerMinute: null,
          linesPerMinute: null,
          error: (error as Error).message,
        };
      }
    });
    rates.sort((a, b) => (b.bytesPerMinute ?? -1) - (a.bytesPerMinute ?? -1));
    return { minutes, measuredAt: now, rates };
  }

  async apply(input: { containerIds: string[]; recreate: boolean; actorUserId: number | null }): Promise<ApplyResult[]> {
    const wanted = new Set(input.containerIds);
    const selected = this.inventory.snapshot.containers.filter((container) => wanted.has(container.id));
    const inspected = await this.#inspectAll(selected);
    const rules = this.rules();
    const results: ApplyResult[] = [];

    const byProject = new Map<string, Inspected[]>();
    for (const entry of inspected) {
      const base = { containerId: entry.summary.id, name: entry.summary.name, running: entry.summary.state === 'running', jobId: null };
      if (entry.summary.isSelf) {
        results.push({ ...base, outcome: 'error', message: 'self' });
        continue;
      }
      if (!effectiveRule(rules, entry.summary.name, imageKeyOf(entry.summary.imageRef))) {
        results.push({ ...base, outcome: 'no-rule', message: null });
        continue;
      }
      if (entry.summary.projectKey) {
        const list = byProject.get(entry.summary.projectKey) ?? [];
        list.push(entry);
        byProject.set(entry.summary.projectKey, list);
      } else {
        results.push(await this.#applyStandalone(entry, rules, input));
      }
    }

    for (const entries of byProject.values()) {
      results.push(...(await this.#applyCompose(entries, rules, input)));
    }
    return results;
  }

  async #applyStandalone(
    entry: Inspected,
    rules: StoredRule[],
    input: { recreate: boolean; actorUserId: number | null },
  ): Promise<ApplyResult> {
    const running = entry.summary.state === 'running';
    const base = { containerId: entry.summary.id, name: entry.summary.name, running, jobId: null };
    const rule = effectiveRule(rules, entry.summary.name, imageKeyOf(entry.summary.imageRef))!;
    if (ruleDifferences(rule, this.#effectiveHealthcheck(entry), this.#effectiveLogging(entry)).length === 0) {
      return { ...base, outcome: 'unchanged', message: null };
    }
    try {
      this.recreator.assertSupported(entry.inspect);
    } catch (error) {
      return { ...base, outcome: 'error', message: (error as Error).message };
    }
    if (rule.healthcheck?.mode === 'set' && !rule.healthcheck.command && !isActive(this.#effectiveHealthcheck(entry)) && !isActive(this.#imageHealthcheck(entry))) {
      return { ...base, outcome: 'error', message: 'needs-command' };
    }
    if (running && !input.recreate) return { ...base, outcome: 'pending-update', message: null };
    try {
      const { job } = await this.updater.enqueueContainerTuning({ containerId: entry.summary.id, actorUserId: input.actorUserId });
      return { ...base, outcome: 'queued', message: null, jobId: job.id };
    } catch (error) {
      return { ...base, outcome: 'error', message: (error as Error).message };
    }
  }

  async #applyCompose(
    entries: Inspected[],
    rules: StoredRule[],
    input: { recreate: boolean; actorUserId: number | null },
  ): Promise<ApplyResult[]> {
    const first = entries[0]!;
    const project = first.project;
    const fail = (message: string): ApplyResult[] =>
      entries.map((entry) => ({
        containerId: entry.summary.id,
        name: entry.summary.name,
        running: entry.summary.state === 'running',
        outcome: 'error' as const,
        message,
        jobId: null,
      }));

    if (!project) return fail('project-not-found');
    if (!project.editable || project.configFiles.length !== 1) return fail(`not-editable:${project.editableReason ?? 'read-only-mount'}`);
    const target = { name: project.name, dir: project.workingDir, composeFile: project.configFiles[0]! };
    const composeTarget = { projectName: project.name, workingDir: project.workingDir, configFiles: project.configFiles };

    let original: string;
    try {
      original = await readFile(target.composeFile, 'utf8');
      await this.compose.validate(composeTarget);
    } catch (error) {
      this.log.debug(`El compose de ${project.name} no valida antes de tocarlo`, error);
      return fail('invalid-before');
    }

    let text = original;
    const edited: Array<{ entry: Inspected; error: string | null }> = [];
    for (const entry of entries) {
      const rule = effectiveRule(rules, entry.summary.name, imageKeyOf(entry.summary.imageRef))!;
      try {
        const image = this.#imageHealthcheck(entry);
        text = applyRuleToService(text, entry.summary.serviceName ?? '', rule, isActive(image) ? image : null).text;
        edited.push({ entry, error: null });
      } catch (error) {
        edited.push({ entry, error: error instanceof ComposeEditError ? error.reason : (error as Error).message });
      }
    }

    if (text !== original) {
      try {
        await this.projectFiles.update({ target, compose: text, actorUserId: input.actorUserId });
        await this.compose.validate(composeTarget);
      } catch (error) {
        this.log.warn(`El compose de ${project.name} no valida tras aplicar la regla; se deja como estaba`, error);
        await this.projectFiles.update({ target, compose: original, actorUserId: input.actorUserId }).catch(() => undefined);
        return fail('invalid-after');
      }
    }

    const results: ApplyResult[] = [];
    for (const { entry, error } of edited) {
      const running = entry.summary.state === 'running';
      const base = { containerId: entry.summary.id, name: entry.summary.name, running, jobId: null };
      if (error) {
        results.push({ ...base, outcome: 'error', message: error });
        continue;
      }
      const rule = effectiveRule(rules, entry.summary.name, imageKeyOf(entry.summary.imageRef))!;
      const stale = ruleDifferences(rule, this.#effectiveHealthcheck(entry), this.#effectiveLogging(entry)).length > 0;
      if (!stale) {
        results.push({ ...base, outcome: text !== original ? 'written' : 'unchanged', message: null });
        continue;
      }
      if (!running) {
        results.push({ ...base, outcome: 'written', message: null });
        continue;
      }
      if (!input.recreate) {
        results.push({ ...base, outcome: 'pending-recreate', message: null });
        continue;
      }
      try {
        const { job } = await this.updater.enqueueServiceAction({
          projectKey: project.key,
          serviceName: entry.summary.serviceName ?? '',
          action: 'recreate',
          actorUserId: input.actorUserId,
        });
        results.push({ ...base, outcome: 'queued', message: null, jobId: job.id });
      } catch (queueError) {
        results.push({ ...base, outcome: 'error', message: (queueError as Error).message });
      }
    }
    return results;
  }

  #row(entry: Inspected, rules: StoredRule[], daemonLogDriver: string | null): ContainerTuningRow {
    const { summary, project, declared } = entry;
    const isCompose = Boolean(summary.projectKey);
    const effective = this.#effectiveHealthcheck(entry);
    const image = this.#imageHealthcheck(entry);
    const composeDeclared = isCompose ? (declared?.healthcheck ?? null) : undefined;
    const logging = this.#effectiveLogging(entry, daemonLogDriver);
    const imageKey = imageKeyOf(summary.imageRef);
    const rule = effectiveRule(rules, summary.name, imageKey);

    let ruleState: ContainerTuningRow['rule'] = null;
    if (rule) {
      const differs = ruleDifferences(rule, effective, logging);
      let status: 'ok' | 'pending-recreate' | 'not-applied' = differs.length === 0 ? 'ok' : 'not-applied';
      if (status === 'not-applied' && isCompose && declared && this.#declaredSatisfies(rule, declared, image)) {
        status = 'pending-recreate';
      }
      ruleState = { scope: rule.scope, key: rule.key, status, differs };
    }

    let apply: ContainerTuningRow['apply'] = { mode: isCompose ? 'compose' : 'recreate', reason: null };
    if (summary.isSelf) apply = { mode: 'unsupported', reason: 'self' };
    else if (isCompose && (!project || !project.editable)) {
      apply = { mode: 'unsupported', reason: `not-editable:${project?.editableReason ?? 'yaml-not-accessible'}` };
    } else if (!isCompose) {
      try {
        this.recreator.assertSupported(entry.inspect);
      } catch (error) {
        apply = { mode: 'unsupported', reason: (error as Error).message };
      }
    }

    return {
      id: summary.id,
      name: summary.name,
      image: summary.image,
      imageKey,
      projectKey: summary.projectKey,
      projectName: summary.projectName,
      serviceName: summary.serviceName,
      state: summary.state,
      isSelf: summary.isSelf,
      healthcheck: {
        source: healthcheckSource({ effective, image, compose: composeDeclared }),
        effective: isActive(effective) ? effective : null,
        image: isActive(image) ? image : null,
        compose: composeDeclared ?? null,
        probesPerMinute: summary.state === 'running' ? probesPerMinute(effective) : null,
        withoutCompose: isCompose && isActive(image) ? image : null,
      },
      logging: {
        driver: logging.driver,
        options: logging.options,
        optionsKnown: logging.optionsKnown,
        fromCompose: Boolean(declared?.logging),
        warning: logging.optionsKnown ? loggingWarning(logging.driver, logging.options) : null,
      },
      rule: ruleState,
      apply,
    };
  }

  #declaredSatisfies(rule: TuningRule, declared: DeclaredService, image: HealthcheckInfo | 'disabled' | null): boolean {
    let healthcheck: HealthcheckInfo | 'disabled' | null = declared.healthcheck;
    if (healthcheck && healthcheck !== 'disabled' && !healthcheck.test && isActive(image)) {
      healthcheck = { ...healthcheck, test: image.test };
    }
    if (!declared.healthcheck && isActive(image)) healthcheck = image;
    return healthcheckMatches(rule.healthcheck, healthcheck) && loggingMatches(rule.logging, declared.logging);
  }

  #effectiveHealthcheck(entry: Inspected): HealthcheckInfo | 'disabled' | null {
    return fromDockerHealthcheck(entry.inspect.Config.Healthcheck);
  }

  #imageHealthcheck(entry: Inspected): HealthcheckInfo | 'disabled' | null {
    return fromDockerHealthcheck(entry.image?.Config?.Healthcheck);
  }

  #effectiveLogging(entry: Inspected, daemonLogDriver: string | null = null): LoggingRule & { optionsKnown: boolean } {
    const config = entry.inspect.HostConfig.LogConfig;
    return {
      driver: config?.Type || daemonLogDriver || 'json-file',
      options: { ...(config?.Config ?? {}) },
      optionsKnown: config?.Config !== null,
    };
  }

  async #inspectAll(containers: ContainerSummary[]): Promise<Inspected[]> {
    const projects = this.inventory.snapshot.projects;
    const files = new Map<string, Promise<string | null>>();
    const readCompose = (path: string): Promise<string | null> => {
      let pending = files.get(path);
      if (!pending) {
        pending = readFile(path, 'utf8').catch(() => null);
        files.set(path, pending);
      }
      return pending;
    };

    const inspected = await mapLimited(containers, 4, async (summary): Promise<Inspected | null> => {
      const inspect = await this.docker.inspectContainer(summary.id).catch(() => null);
      if (!inspect) return null;
      const image = await this.#image(inspect.Image);
      const project = summary.projectKey ? (projects.find((p) => p.key === summary.projectKey) ?? null) : null;
      let declared: DeclaredService | null = null;
      let composeText: string | null = null;
      if (project && project.yamlAccessible && project.configFiles.length === 1 && summary.serviceName) {
        composeText = await readCompose(project.configFiles[0]!);
        if (composeText !== null) {
          try {
            declared = readDeclaredService(composeText, summary.serviceName);
          } catch {
            declared = null;
          }
        }
      }
      return { summary, inspect, image, project, declared, composeText };
    });
    return inspected.filter((entry): entry is Inspected => entry !== null);
  }

  async #image(id: string): Promise<ImageInspect | null> {
    if (this.#images.has(id)) return this.#images.get(id)!;
    const image = await this.docker.inspectImage(id).catch(() => null);
    this.#images.set(id, image);
    return image;
  }

  async #daemonLogDriver(): Promise<string | null> {
    if (this.#daemonDriver && Date.now() - this.#daemonDriver.at < DAEMON_INFO_TTL_MS) return this.#daemonDriver.value;
    const value = await this.docker.daemonLogDriver().catch(() => null);
    this.#daemonDriver = { value, at: Date.now() };
    return value;
  }
}
