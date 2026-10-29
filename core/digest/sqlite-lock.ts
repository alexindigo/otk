// SPDX-License-Identifier: LGPL-3.0-only
/** Deno's pinned node:sqlite exposes the SQLite busy message and generic code. */
export function sqliteBusy(error: unknown): boolean {
  return error instanceof Error &&
    Reflect.get(error, "code") === "ERR_SQLITE_ERROR" &&
    error.message === "database is locked";
}

/** Retry fail-fast lock admission through the caller's cooperative wait port. */
export async function sqliteRetry<T>(
  read: () => T | Promise<T>,
  signal: AbortSignal,
  policy: { busyms: number; retryms: number },
  wait: <U>(readiness: Promise<U>) => Promise<U>,
): Promise<T> {
  let first: number | undefined;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      signal.throwIfAborted();
      if (!sqliteBusy(error)) throw error;
      first ??= performance.now();
      const remaining = policy.busyms - (performance.now() - first);
      if (remaining <= 0) throw error;
      await wait(
        new Promise<void>((resolve, reject) => {
          const finish = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          const timer = setTimeout(finish, Math.min(policy.retryms, remaining));
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
        }),
      );
    }
  }
}
