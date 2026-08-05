const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

type AttemptWindow = {
  count: number;
  resetAt: number;
};

const attempts = new Map<string, AttemptWindow>();

export function allowLoginAttempt(key: string, now = Date.now()): boolean {
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  if (current.count >= MAX_ATTEMPTS) {
    return false;
  }

  current.count += 1;
  return true;
}

export function clearLoginAttempts(key: string): void {
  attempts.delete(key);
}
