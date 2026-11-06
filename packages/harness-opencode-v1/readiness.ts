// SPDX-License-Identifier: LGPL-3.0-only
/** One bounded native operation. Permission and settlement never occupy execution. */
export class NativeReadiness {
  constructor(
    readonly wait: <T>(readiness: Promise<T>, join?: boolean) => Promise<T>,
    readonly admission?: (signal: AbortSignal) => Promise<() => void>,
  ) {}
  async run<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
    admit = true,
  ): Promise<T> {
    let release: (() => void) | undefined;
    if (this.admission && admit) {
      const permission = this.admission(signal);
      try {
        release = await this.wait(permission);
      } catch (error) {
        // A canceled continuation may already have been granted permission.
        void permission.then((value) => value(), () => {});
        throw error;
      }
    }
    let pending: Promise<T> | undefined;
    try {
      signal.throwIfAborted();
      pending = work().finally(() => release?.());
      const value = await this.wait(pending);
      signal.throwIfAborted();
      return value;
    } finally {
      if (release) {
        if (pending) {
          await this.wait(pending.then(() => undefined, () => undefined), true);
        } else release();
      }
    }
  }
}
