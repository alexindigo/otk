// SPDX-License-Identifier: LGPL-3.0-only
export type StorageProblem = "full" | "io";
/** Driver codes, not arbitrary error prose, establish storage availability. */
export function storageProblem(cause: unknown): StorageProblem | undefined {
  if (cause instanceof StorageFailure) return cause.problem;
  if (!cause || typeof cause !== "object") return;
  const error = cause as {
    code?: string;
    errcode?: number;
    errno?: number;
    cause?: unknown;
    message?: string;
  };
  const sqlite = typeof error.errcode === "number"
    ? error.errcode & 255
    : undefined;
  if (
    sqlite === 13 ||
    ["SQLITE_FULL", "ENOSPC", "EDQUOT"].includes(error.code ?? "") ||
    error.errno === 28 || error.errno === 122
  ) return "full";
  if (
    [10, 14].includes(sqlite ?? -1) ||
    ["SQLITE_IOERR", "EIO", "EROFS"].includes(error.code ?? "")
  ) return "io";
  // Deno 2.9's SQLite path exposes only the generic driver code for some calls.
  if (error.code === "ERR_SQLITE_ERROR") {
    if (error.message === "database or disk is full") return "full";
    if (
      [
        "disk I/O error",
        "unable to open database file",
        "attempt to write a readonly database",
      ].includes(error.message ?? "")
    ) return "io";
  }
  return error.cause !== cause ? storageProblem(error.cause) : undefined;
}
/** The original native cause and the exact owning operation stay diagnostic. */
export class StorageFailure extends Error {
  constructor(
    readonly problem: StorageProblem,
    readonly database: string,
    readonly operation: string,
    cause: unknown,
  ) {
    super(`Storage ${problem}: ${database} (${operation})`, { cause });
    this.name = "StorageFailure";
  }
}
export interface StorageStatus {
  degraded: boolean;
  problem?: StorageProblem;
  /** A failure may have interrupted observation; recovery cannot certify that interval. */
  gap: number;
}
/** One owner per process. Worker connections report their owner across the bridge. */
export class StorageAvailability {
  #failures = new Map<string, StorageFailure>();
  #probes = new Map<string, () => void>();
  #listeners = new Set<(status: StorageStatus) => void>();
  #gap = 0;
  status(): StorageStatus {
    return {
      degraded: this.#failures.size > 0,
      ...(this.#failures.size
        ? {
          problem: [...this.#failures.values()].some((failure) =>
              failure.problem === "full"
            )
            ? "full" as const
            : "io" as const,
        }
        : {}),
      gap: this.#gap,
    };
  }
  listen(listener: (status: StorageStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #publish(): void {
    const status = this.status();
    for (const listener of this.#listeners) {
      try {
        listener(status);
      } catch (error) {
        console.error("Storage observer failed", error);
      }
    }
  }
  failed(failure: StorageFailure): void {
    const previous = this.#failures.get(failure.database);
    if (
      previous && (previous.problem === "full" || failure.problem !== "full")
    ) return;
    if (!this.#failures.size) this.#gap++;
    this.#failures.set(failure.database, failure);
    this.#publish();
  }
  remote(database: string, status: StorageStatus): void {
    if (status.degraded) {
      this.failed(
        new StorageFailure(
          status.problem ?? "io",
          database,
          "remote owner",
          undefined,
        ),
      );
    } else this.recovered(database);
  }
  recovered(database: string): void {
    if (this.#failures.delete(database)) this.#publish();
  }
  failure(database: string): StorageFailure | undefined {
    return this.#failures.get(database);
  }
  register(database: string, probe: () => void): () => void {
    this.#probes.set(database, probe);
    return () => {
      this.#probes.delete(database);
      this.recovered(database);
    };
  }
  /** At most one tiny synchronous transaction per failed connection per tick. */
  probe(): void {
    for (const database of [...this.#failures.keys()]) {
      const probe = this.#probes.get(database);
      if (!probe) continue;
      try {
        probe();
        this.recovered(database);
      } catch (error) {
        if (!storageProblem(error)) {
          console.error("Storage recovery probe failed", error);
        }
      }
    }
  }
}
export const processStorage = new StorageAvailability();
