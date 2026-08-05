export type PriorityInput = {
  severity: number;
  affectedCount: number;
  timeSensitivity: number;
  environmentHazard?: number;
  waitSeconds?: number;
};

export function scorePriority(input: PriorityInput): number {
  const severity = clamp(input.severity, 1, 5) / 5;
  const affected = Math.min(input.affectedCount, 500) / 500;
  const timeSens = clamp(input.timeSensitivity, 1, 5) / 5;
  const env = clamp(input.environmentHazard ?? 1, 1, 5) / 5;
  const wait = Math.min(input.waitSeconds ?? 0, 3600) / 3600;
  const raw =
    0.35 * severity + 0.2 * affected + 0.25 * timeSens + 0.1 * env + 0.1 * wait;
  return Math.round(raw * 1000) / 10;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
