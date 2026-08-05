export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = 'closed';
  private openedAt = 0;
  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(threshold = 3, resetMs = 30_000) {
    this.threshold = threshold;
    this.resetMs = resetMs;
  }

  getStatus(): { state: CircuitState; failures: number } {
    this.maybeHalfOpen();
    return { state: this.state, failures: this.failures };
  }

  async exec<T>(
    fn: () => Promise<T>,
    fallback: () => Promise<T> | T,
  ): Promise<T> {
    this.maybeHalfOpen();
    if (this.state === 'open') {
      return fallback();
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'closed';
      return result;
    } catch {
      this.failures += 1;
      if (this.failures >= this.threshold) {
        this.state = 'open';
        this.openedAt = Date.now();
      }
      return fallback();
    }
  }

  private maybeHalfOpen() {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.resetMs) {
      this.state = 'half-open';
    }
  }
}
