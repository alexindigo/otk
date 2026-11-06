// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestPriority } from "@otk/harness";
export interface DigestPublicationReservation {
  run<T>(signal: AbortSignal, publish: () => Promise<T>): Promise<T>;
  release(): void;
  priority(): DigestPriority;
  required(): boolean;
}
interface Node {
  previous?: Node;
  tail: Promise<void>;
  retired: boolean;
  optional: boolean;
  priority: DigestPriority;
  effective: DigestPriority;
  required: boolean;
}
const ranks: DigestPriority[] = [
  "interactive",
  "attention",
  "visible",
  "background",
];
/** Source-free identity ordering and dependency-local priority donation. */
export class DigestPublicationOrder {
  #tails = new Map<string, Node>();
  constructor(
    readonly wait: <T>(readiness: Promise<T>) => Promise<T>,
    readonly schedule: <T>(
      signal: AbortSignal,
      publish: () => Promise<T>,
      reservation: DigestPublicationReservation,
    ) => Promise<T> = (_signal, publish) => publish(),
    readonly changed: () => void = () => {},
  ) {}
  #refresh(identity: string): void {
    let donation: DigestPriority | undefined;
    for (let node = this.#tails.get(identity); node; node = node.previous) {
      if (
        !node.retired && !node.optional &&
        (donation === undefined ||
          ranks.indexOf(node.priority) < ranks.indexOf(donation))
      ) donation = node.priority;
      node.required = !node.optional || donation !== undefined;
      node.effective = donation !== undefined &&
          ranks.indexOf(donation) < ranks.indexOf(node.priority)
        ? donation
        : node.priority;
    }
    this.changed();
  }
  reserve(
    identity: string,
    priority: DigestPriority = "interactive",
    optional = false,
  ): DigestPublicationReservation {
    const previous = this.#tails.get(identity);
    const done = Promise.withResolvers<void>();
    const tail = (previous?.tail ?? Promise.resolve()).then(() => done.promise);
    const node: Node = {
      previous,
      tail,
      retired: false,
      optional,
      priority,
      effective: priority,
      required: !optional,
    };
    this.#tails.set(identity, node);
    this.#refresh(identity);
    let started = false;
    const release = () => {
      if (node.retired) return;
      node.retired = true;
      done.resolve();
      this.#refresh(identity);
      // A canceled middle node cannot sever its predecessor's ordering fence.
      void tail.then(() => {
        if (this.#tails.get(identity) === node) this.#tails.delete(identity);
      });
    };
    const reservation: DigestPublicationReservation = {
      release,
      priority: () => node.effective,
      required: () => node.required,
      run: async (signal, publish) => {
        if (started || node.retired) {
          throw new Error("Publication reservation is retired");
        }
        started = true;
        let executing = false;
        try {
          return await this.schedule(signal, async () => {
            executing = true;
            try {
              await this.wait(previous?.tail ?? Promise.resolve());
              signal.throwIfAborted();
              return await publish();
            } finally {
              release();
            }
          }, reservation);
        } finally {
          if (!executing) release();
        }
      },
    };
    return reservation;
  }
}
