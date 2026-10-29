/** Coalesce reads and discard responses from a previous installation/session. */
export function createRefreshCoordinator<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
): { run(): Promise<void>; invalidate(): void } {
  let generation = 0;
  let pending: Promise<void> | undefined;

  return {
    run() {
      if (pending) return pending;
      const requestGeneration = generation;
      const request = Promise.resolve()
        .then(read)
        .then((value) => {
          if (requestGeneration === generation) apply(value);
        })
        .catch((error: unknown) => {
          // Stale failures are no more authoritative than stale successes.
          if (requestGeneration === generation) throw error;
        })
        .finally(() => {
          if (pending === request) pending = undefined;
        });
      pending = request;
      return request;
    },
    invalidate() {
      generation++;
      pending = undefined;
    },
  };
}
