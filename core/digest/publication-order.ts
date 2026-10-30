// SPDX-License-Identifier: LGPL-3.0-only
export interface DigestPublicationReservation {
  run<T>(signal: AbortSignal, publish: () => Promise<T>): Promise<T>;
  release(): void;
}
/** Source-free identity ordering; committed publications own their execution. */
export class DigestPublicationOrder {
  #tails = new Map<string, Promise<void>>();
  constructor(
    readonly wait: <T>(readiness: Promise<T>) => Promise<T>,
    readonly schedule: <T>(
      signal: AbortSignal,
      publish: () => Promise<T>,
    ) => Promise<T> = (_signal, publish) => publish(),
  ) {}
  reserve(identity: string): DigestPublicationReservation {
    const previous = this.#tails.get(identity) ?? Promise.resolve();
    const done = Promise.withResolvers<void>();
    const tail = previous.then(() => done.promise);
    this.#tails.set(identity, tail);
    let retired = false, started = false;
    const release = () => {
      if (retired) return;
      retired = true;
      done.resolve();
      // A canceled middle reservation still waits for its predecessor. It cannot
      // sever the chain and let a successor publish through the old producer.
      void tail.then(() => {
        if (this.#tails.get(identity) === tail) this.#tails.delete(identity);
      });
    };
    return {
      release,
      run: async (signal, publish) => {
        if (started || retired) {
          throw new Error("Publication reservation is retired");
        }
        started = true;
        let executing = false;
        try {
          return await this.schedule(signal, async () => {
            executing = true;
            try {
              await this.wait(previous);
              signal.throwIfAborted();
              return await publish();
            } finally {
              // Release from the publication's execution, before its producer
              // resumes. Interactive pressure may have paused that producer.
              release();
            }
          });
        } finally {
          // Scheduling can reject before the publication acquires execution.
          if (!executing) release();
        }
      },
    };
  }
}
