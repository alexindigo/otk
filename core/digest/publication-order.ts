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
  #groups = new Set<Node[]>();
  constructor(
    readonly wait: <T>(readiness: Promise<T>) => Promise<T>,
    readonly schedule: <T>(
      signal: AbortSignal,
      publish: () => Promise<T>,
      reservation: DigestPublicationReservation,
    ) => Promise<T> = (_signal, publish) => publish(),
    readonly changed: () => void = () => {},
  ) {}
  #refresh(): void {
    const groups = [...this.#groups];
    for (const nodes of groups) {
      for (const node of nodes) {
        node.required = !node.retired && !node.optional;
        node.effective = node.priority;
      }
    }
    // Reservation order is a dependency DAG: every predecessor is older.
    for (const nodes of groups.reverse()) {
      if (nodes.some((node) => !node.retired)) {
        const required = nodes.some((node) => node.required);
        const effective = nodes.reduce(
          (best, node) =>
            ranks.indexOf(node.effective) < ranks.indexOf(best)
              ? node.effective
              : best,
          nodes[0].priority,
        );
        for (const node of nodes) {
          node.required = required;
          node.effective = effective;
        }
      }
      // Retired members no longer join identities, but still relay their own
      // successor's demand across the retained identity ordering fence.
      for (const node of nodes) {
        const previous = node.previous;
        if (!node.required || !previous) continue;
        previous.required = true;
        if (ranks.indexOf(node.effective) < ranks.indexOf(previous.effective)) {
          previous.effective = node.effective;
        }
      }
    }
    this.changed();
  }
  reserve(
    identity: string,
    priority: DigestPriority = "interactive",
    optional = false,
  ): DigestPublicationReservation {
    return this.reserveAll([identity], priority, optional);
  }
  /** One credited publication for a bounded set, each identity still ordered. */
  reserveAll(
    identities: readonly string[],
    priority: DigestPriority = "interactive",
    optional = false,
  ): DigestPublicationReservation {
    const parts = [...new Set(identities)].map((identity) => {
      const previous = this.#tails.get(identity);
      const done = Promise.withResolvers<void>();
      const tail = (previous?.tail ?? Promise.resolve()).then(() =>
        done.promise
      );
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
      return { identity, previous, done, tail, node };
    });
    const nodes = parts.map(({ node }) => node);
    this.#groups.add(nodes);
    this.#refresh();
    let started = false;
    const release = () => {
      for (const { identity, done, tail, node } of parts) {
        if (node.retired) continue;
        node.retired = true;
        done.resolve();
        // A canceled middle node cannot sever its predecessor's ordering fence.
        void tail.then(() => {
          if (this.#tails.get(identity) === node) this.#tails.delete(identity);
        });
      }
      this.#refresh();
    };
    void Promise.all(parts.map(({ tail }) => tail)).then(() => {
      this.#groups.delete(nodes);
    });
    const reservation: DigestPublicationReservation = {
      release,
      priority: () =>
        parts.reduce<DigestPriority>(
          (best, { node }) =>
            ranks.indexOf(node.effective) < ranks.indexOf(best)
              ? node.effective
              : best,
          priority,
        ),
      required: () => parts.some(({ node }) => node.required),
      run: async (signal, publish) => {
        if (started || parts.some(({ node }) => node.retired)) {
          throw new Error("Publication reservation is retired");
        }
        started = true;
        let executing = false;
        try {
          return await this.schedule(signal, async () => {
            executing = true;
            try {
              await this.wait(
                Promise.all(
                  parts.map(({ previous }) =>
                    previous?.tail ?? Promise.resolve()
                  ),
                ).then(() => {}),
              );
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
