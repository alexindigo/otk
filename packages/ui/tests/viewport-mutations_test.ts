// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { acquireViewport, followViewport } from "../components/viewport.ts";

/** Native mutation delivery precedes the next task, not the next resize frame. */
function fixture(
  run: (value: {
    pane: HTMLElement;
    height(value: number): void;
    mutate(): void;
    flush(): void;
    targets(): number;
    retire(): void;
  }) => void,
) {
  const names = [
    "document",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "ResizeObserver",
    "MutationObserver",
    "Element",
  ] as const;
  const saved = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  );
  const frames = new Map<number, FrameRequestCallback>();
  const mutations: { callback(): void; targets: Set<Element> }[] = [];
  let sequence = 0;
  class ElementFixture extends EventTarget {
    closest() {
      return null;
    }
  }
  class Pane extends ElementFixture {
    scrollHeight = 1000;
    clientHeight = 100;
    #top = 0;
    get scrollTop() {
      return Math.min(this.#top, this.scrollHeight - this.clientHeight);
    }
    set scrollTop(value: number) {
      this.#top = Math.max(
        0,
        Math.min(value, this.scrollHeight - this.clientHeight),
      );
    }
  }
  const pane = new Pane() as unknown as HTMLElement;
  const values = [
    new EventTarget(),
    (callback: FrameRequestCallback) => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    },
    (id: number) => frames.delete(id),
    class {
      observe() {}
      disconnect() {}
    },
    class {
      readonly state: { callback(): void; targets: Set<Element> };
      constructor(callback: () => void) {
        this.state = { callback, targets: new Set() };
        mutations.push(this.state);
      }
      observe(target: Element) {
        this.state.targets.add(target);
      }
      disconnect() {
        this.state.targets.clear();
      }
    },
    ElementFixture,
  ];
  names.forEach((name, i) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: values[i],
    })
  );
  const flush = () => {
    const next = [...frames.values()];
    frames.clear();
    next.forEach((callback) => callback(0));
  };
  const following = followViewport(pane, pane);
  try {
    flush();
    assertEquals(pane.scrollTop, 900);
    run({
      pane,
      height: (value) => {
        Object.assign(pane, { scrollHeight: value });
      },
      mutate: () => mutations.forEach((value) => value.callback()),
      flush,
      targets: () => mutations.reduce((n, value) => n + value.targets.size, 0),
      retire: () => following.dispose(),
    });
  } finally {
    following.dispose();
    names.forEach((name, i) => {
      if (saved[i]) Object.defineProperty(globalThis, name, saved[i]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

Deno.test("root flow mutation commits tail geometry before another animation frame", () => {
  fixture(({ pane, height, mutate }) => {
    height(1028);
    mutate();
    assertEquals(
      pane.scrollTop,
      928,
      "Non-window chrome growth must join root follow synchronously",
    );
  });
});

Deno.test("root flow mutation preserves the measured anchored source without changing reader intent", () => {
  fixture(({ pane, height, mutate, flush }) => {
    const lease = acquireViewport(pane);
    let prefix = 800;
    const release = lease.owner.register({
      id: "source",
      depth: 1,
      anchor: () => ({ key: "paragraph", offset: pane.scrollTop - prefix }),
      resolve: (anchor) => prefix + anchor.offset,
    });
    try {
      lease.owner.keepAnchor();
      flush();
      prefix += 28;
      height(1028);
      mutate();
      assertEquals(
        pane.scrollTop,
        928,
        "Non-window growth preserves the existing source offset",
      );
      assertEquals(lease.owner.following(), false);
    } finally {
      release();
      lease.release();
    }
  });
});

Deno.test("root flow observation shares leases and releases DOM mutation ownership", () => {
  fixture(({ pane, targets }) => {
    const lease = acquireViewport(pane);
    const release = lease.owner.observe(pane);
    assertEquals(targets(), 1, "Borrowers share one native flow observation");
    release();
    assertEquals(targets(), 1, "Remaining flow borrower retains observation");
    lease.release();
  });
});

Deno.test("retired root ignores late mutation delivery and releases every flow", () => {
  fixture(({ pane, targets, retire, height, mutate }) => {
    retire();
    assertEquals(targets(), 0);
    height(2000);
    mutate();
    assertEquals(
      pane.scrollTop,
      900,
      "Retired roots cannot write another layout",
    );
  });
});
