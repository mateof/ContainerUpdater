import type { Db } from '../index.js';
import type {
  HealthcheckRule,
  ImpactDiskResult,
  ImpactProbe,
  ImpactState,
  LoggingRule,
  RuleScope,
  StoredRule,
  TuningRule,
} from '@cu/shared';

interface RuleRow {
  scope: RuleScope;
  key: string;
  healthcheck: string | null;
  logging: string | null;
  updated_at: number;
}

interface ProbeRow {
  id: number;
  container_id: string;
  container_name: string;
  minutes: number;
  state: ImpactState;
  started_at: number;
  ends_at: number;
  finished_at: number | null;
  error: string | null;
  result: string | null;
}

function toRule(row: RuleRow): StoredRule {
  return {
    scope: row.scope,
    key: row.key,
    healthcheck: row.healthcheck ? (JSON.parse(row.healthcheck) as HealthcheckRule) : null,
    logging: row.logging ? (JSON.parse(row.logging) as LoggingRule) : null,
    updatedAt: row.updated_at,
  };
}

function toProbe(row: ProbeRow): ImpactProbe {
  return {
    id: row.id,
    containerId: row.container_id,
    containerName: row.container_name,
    minutes: row.minutes,
    state: row.state,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    finishedAt: row.finished_at,
    error: row.error,
    disks: row.result ? (JSON.parse(row.result) as ImpactDiskResult[]) : [],
  };
}

export function createDiskHealthRepository(db: Db) {
  const upsert = db.prepare(
    `INSERT INTO tuning_rules (scope, key, healthcheck, logging, updated_at)
     VALUES (@scope, @key, @healthcheck, @logging, @updatedAt)
     ON CONFLICT(scope, key) DO UPDATE SET
       healthcheck = excluded.healthcheck,
       logging = excluded.logging,
       updated_at = excluded.updated_at`,
  );

  return {
    rules(): StoredRule[] {
      return (db.prepare('SELECT * FROM tuning_rules ORDER BY scope, key').all() as RuleRow[]).map(toRule);
    },

    saveRules(scope: RuleScope, keys: string[], rule: TuningRule, now = Date.now()): void {
      db.transaction(() => {
        for (const key of keys) {
          upsert.run({
            scope,
            key,
            healthcheck: rule.healthcheck ? JSON.stringify(rule.healthcheck) : null,
            logging: rule.logging ? JSON.stringify(rule.logging) : null,
            updatedAt: now,
          });
        }
      })();
    },

    deleteRule(scope: RuleScope, key: string): boolean {
      return db.prepare('DELETE FROM tuning_rules WHERE scope = ? AND key = ?').run(scope, key).changes > 0;
    },

    createProbe(input: { containerId: string; containerName: string; minutes: number; startedAt: number; endsAt: number }): number {
      const result = db
        .prepare(
          `INSERT INTO impact_probes (container_id, container_name, minutes, state, started_at, ends_at)
           VALUES (?, ?, ?, 'running', ?, ?)`,
        )
        .run(input.containerId, input.containerName, input.minutes, input.startedAt, input.endsAt);
      return Number(result.lastInsertRowid);
    },

    finishProbe(id: number, state: ImpactState, result: ImpactDiskResult[], error: string | null, now = Date.now()): void {
      db.prepare('UPDATE impact_probes SET state = ?, result = ?, error = ?, finished_at = ? WHERE id = ?').run(
        state,
        result.length > 0 ? JSON.stringify(result) : null,
        error,
        now,
        id,
      );
    },

    runningProbes(): ImpactProbe[] {
      return (db.prepare("SELECT * FROM impact_probes WHERE state = 'running'").all() as ProbeRow[]).map(toProbe);
    },

    recentProbes(limit = 20): ImpactProbe[] {
      return (db.prepare('SELECT * FROM impact_probes ORDER BY id DESC LIMIT ?').all(limit) as ProbeRow[]).map(toProbe);
    },
  };
}
