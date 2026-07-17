export class SessionTerminalizationLatch {
  private current: { sessionId: string; promise: Promise<void> } | null = null;

  run(sessionId: string, operation: () => Promise<void>): Promise<void> {
    if (this.current?.sessionId === sessionId) return this.current.promise;
    const promise = Promise.resolve().then(operation);
    this.current = { sessionId, promise };
    void promise.catch(() => {
      if (this.current?.sessionId === sessionId && this.current.promise === promise) {
        this.current = null;
      }
    });
    return promise;
  }

  reset() {
    this.current = null;
  }
}

export async function retryTerminalCompletion<T>(
  operation: () => Promise<T>,
  retryDelaysMs: readonly number[] = [250, 750],
): Promise<T> {
  let lastFailure: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt - 1]));
    }
    try {
      return await operation();
    } catch (failure) {
      lastFailure = failure;
    }
  }
  throw lastFailure;
}
