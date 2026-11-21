import { BYTES_PER_TB } from '@cu/shared';

export const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

export const MIN_LIFETIME_COVERAGE_SECONDS = 10 * 60;

export function remainingBytes(input: {
  tbwTb: number | null;
  writtenTb: number | null;
  writtenSinceBytes: number;
}): number | null {
  if (input.tbwTb === null || input.tbwTb <= 0) return null;
  const used = (input.writtenTb ?? 0) * BYTES_PER_TB + Math.max(0, input.writtenSinceBytes);
  return Math.max(0, input.tbwTb * BYTES_PER_TB - used);
}

export function yearsLeft(remaining: number | null, bytesPerSecond: number | null): number | null {
  if (remaining === null || bytesPerSecond === null || bytesPerSecond <= 0) return null;
  return remaining / (bytesPerSecond * SECONDS_PER_YEAR);
}

export function windowRate(bytes: number, seconds: number): number | null {
  if (seconds < MIN_LIFETIME_COVERAGE_SECONDS) return null;
  return bytes / seconds;
}
