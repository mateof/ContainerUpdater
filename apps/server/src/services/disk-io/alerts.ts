export const RECOVERY_RATIO = 0.9;

export type AlertSubjectKind = 'disk' | 'container';

export interface AlertInput {
  kind: AlertSubjectKind;
  name: string;
  rateBps: number | null;
  thresholdBps: number;
}

export interface ActiveAlert {
  kind: AlertSubjectKind;
  name: string;
  alertedAt: number;
  rateBps: number;
}

export interface AlertTransition {
  kind: AlertSubjectKind;
  name: string;
  type: 'over' | 'recovered';
  rateBps: number;
  thresholdBps: number;
  since: number;
}

export function alertSubject(kind: AlertSubjectKind, name: string): string {
  return `${kind}:${name}`;
}

export function evaluateAlerts(
  inputs: AlertInput[],
  active: Map<string, ActiveAlert>,
  now: number,
): { transitions: AlertTransition[]; next: Map<string, ActiveAlert> } {
  const transitions: AlertTransition[] = [];
  const next = new Map<string, ActiveAlert>();

  for (const input of inputs) {
    const subject = alertSubject(input.kind, input.name);
    const current = active.get(subject);

    if (input.rateBps === null) {
      if (current) next.set(subject, current);
      continue;
    }

    if (!current && input.rateBps > input.thresholdBps) {
      const alert = { kind: input.kind, name: input.name, alertedAt: now, rateBps: input.rateBps };
      next.set(subject, alert);
      transitions.push({
        kind: input.kind,
        name: input.name,
        type: 'over',
        rateBps: input.rateBps,
        thresholdBps: input.thresholdBps,
        since: now,
      });
      continue;
    }

    if (current && input.rateBps < input.thresholdBps * RECOVERY_RATIO) {
      transitions.push({
        kind: input.kind,
        name: input.name,
        type: 'recovered',
        rateBps: input.rateBps,
        thresholdBps: input.thresholdBps,
        since: current.alertedAt,
      });
      continue;
    }

    if (current) next.set(subject, current);
  }

  return { transitions, next };
}
