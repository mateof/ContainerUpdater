/**
 * Comparacion de etiquetas de version.
 *
 * El problema real no es comparar `1.2.3` con `1.2.4`, que lo resuelve
 * cualquier libreria, sino no proponer disparates: `17-alpine` no se debe
 * comparar con `17-bookworm` ni con `17` a secas, porque son imagenes
 * distintas aunque su numero se parezca. Por eso todo gira alrededor del
 * "sabor" de la etiqueta.
 */
import semver from 'semver';
import type { SemverChannel } from '@cu/shared';

export interface ParsedTag {
  raw: string;
  /** Normalmente `v` o vacio. Se conserva para reconstruir el tag propuesto. */
  prefix: string;
  version: string;
  /** Lo que va detras de la version: `-alpine`, `-bookworm`, `-v0`... */
  suffix: string;
  /** Cuantos componentes traia: `8.2` son 2, `8.2.1` son 3. */
  precision: 1 | 2 | 3;
  /** Version rellenada a x.y.z para poder compararla. */
  coerced: string;
}

/**
 * Etiquetas que nunca son versiones. Se excluyen del modo semver: si el usuario
 * sigue `latest` es porque quiere el modo digest.
 */
const ROLLING_TAGS = new Set([
  'latest',
  'stable',
  'edge',
  'main',
  'master',
  'nightly',
  'dev',
  'devel',
  'test',
  'beta',
  'alpha',
  'rc',
]);

const TAG_RE = /^(?<prefix>[vV]?)(?<version>\d+(?:\.\d+){0,2})(?<suffix>[-.].*)?$/;

export function parseTag(tag: string): ParsedTag | null {
  if (ROLLING_TAGS.has(tag.toLowerCase())) return null;

  const match = TAG_RE.exec(tag);
  const groups = match?.groups;
  if (!groups?.version) return null;

  const parts = groups.version.split('.');
  const precision = parts.length as 1 | 2 | 3;
  const coerced = [parts[0] ?? '0', parts[1] ?? '0', parts[2] ?? '0'].join('.');
  if (!semver.valid(coerced)) return null;

  return {
    raw: tag,
    prefix: groups.prefix ?? '',
    version: groups.version,
    suffix: groups.suffix ?? '',
    precision,
    coerced,
  };
}

/**
 * Dos etiquetas son del mismo sabor si comparten sufijo y precision.
 *
 * La precision entra en la comparacion a proposito: `8.2` y `8.2.1` conviven en
 * Docker Hub y significan cosas distintas (una es movil, la otra fija). Saltar
 * de `8.2` a `8.3.1` cambiaria al usuario de esquema de anclaje sin avisar.
 */
export function sameFlavour(a: ParsedTag, b: ParsedTag): boolean {
  return a.suffix.toLowerCase() === b.suffix.toLowerCase() && a.precision === b.precision;
}

/**
 * Busca la etiqueta mas alta compatible con la actual dentro del canal.
 *
 * Devuelve null si no hay nada mejor, lo que incluye el caso frecuente de que
 * la etiqueta actual ya sea la mas alta.
 */
export function findUpgradeCandidate(
  currentTag: string,
  availableTags: string[],
  channel: SemverChannel,
): { tag: string; version: string } | null {
  const current = parseTag(currentTag);
  if (!current) return null;

  const candidates = availableTags
    .map(parseTag)
    .filter((t): t is ParsedTag => t !== null && sameFlavour(t, current))
    // Las preliminares no se proponen nunca de forma automatica: nadie quiere
    // que su NAS salte solo a una release candidate.
    .filter((t) => semver.prerelease(t.coerced) === null)
    .filter((t) => semver.gt(t.coerced, current.coerced))
    .filter((t) => withinChannel(current.coerced, t.coerced, channel));

  if (candidates.length === 0) return null;

  // Orden descendente: el primero es el mas alto.
  candidates.sort((a, b) => semver.rcompare(a.coerced, b.coerced));
  const best = candidates[0];
  if (!best) return null;

  return { tag: best.raw, version: best.coerced };
}

function withinChannel(from: string, to: string, channel: SemverChannel): boolean {
  const diff = semver.diff(from, to);
  if (!diff) return false;
  if (channel === 'major') return true;
  if (channel === 'minor') return diff === 'minor' || diff === 'patch';
  return diff === 'patch';
}

/**
 * Elige el modo de seguimiento por defecto a partir del tag.
 *
 * Un `latest` solo se puede vigilar por digest; un `1.2.3` solo tiene sentido
 * por version. Los parciales como `8.2` se vigilan de las dos formas, porque
 * son a la vez ancla (dentro de 8.2) y movil (puede salir 8.3), y son
 * informaciones distintas que conviene no mezclar.
 */
export function defaultTrackMode(tag: string): 'digest' | 'semver' | 'both' {
  const parsed = parseTag(tag);
  if (!parsed) return 'digest';
  return parsed.precision === 3 ? 'semver' : 'both';
}
