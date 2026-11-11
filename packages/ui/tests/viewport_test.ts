// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { acquireViewport, followViewport } from "../components/viewport.ts";

Deno.test("settled geometry does not repeatedly assign an already-applied position", () => {
  viewportFixture(({ writes, flush }) => {
    const before = writes();
    for (let i = 0; i < 5; i++) flush();
    assertEquals(writes(), before);
  });
});

Deno.test("scrollend without a new input or layout does not undo an observed reader position", () => {
  viewportFixture(({ pane, height, resize, flush }) => {
    pane.scrollTop = 892;
    pane.dispatchEvent(new Event("scroll"));
    pane.dispatchEvent(new Event("scrollend"));
    for (let i = 0; i < 4; i++) flush();
    assertEquals(pane.scrollTop, 892);
    height(1100);
    resize();
    for (let i = 0; i < 4; i++) flush();
    assertEquals(pane.scrollTop, 1000);
  });
});

Deno.test("reveal completes when its relative geometry is measured while preceding content grows", async () => {
  let result!: Promise<void>;
  viewportFixture(({ pane, flush }) => {
    const lease = acquireViewport(pane);
    let start = 700;
    try {
      result = lease.owner.navigate(() => {
        start += 20;
        return { start, end: start + 20, measured: true };
      }, "center");
      void result.catch(() => {});
      for (let i = 0; i < 5; i++) flush();
    } finally {
      lease.release();
    }
  });
  await result;
});

Deno.test("measured follow remains a follow intent through a transient native range clamp", () => {
  viewportFixture(({ pane, height, flush }) => {
    const lease = acquireViewport(pane);
    const release = lease.owner.register({
      id: "rows",
      depth: 1,
      anchor: () => undefined,
      resolve: () => undefined,
    });
    try {
      height(1100);
      lease.owner.layout();
      pane.scrollTop = 800;
      pane.dispatchEvent(new Event("scroll"));
      for (let i = 0; i < 5; i++) flush();
      assertEquals(pane.scrollTop, 1000);
    } finally {
      release();
      lease.release();
    }
  });
});

Deno.test("wheel-away at the top keeps an anchor without waiting for an impossible scrollend", () => {
  viewportFixture(({ pane, height, flush }) => {
    const lease = acquireViewport(pane);
    let prefix = 0;
    const release = lease.owner.register({
      id: "rows",
      depth: 1,
      anchor: () => ({ key: "row", offset: pane.scrollTop - prefix }),
      resolve: (anchor) => prefix + anchor.offset,
    });
    try {
      pane.scrollTop = 0;
      pane.dispatchEvent(new Event("scroll"));
      const event = new Event("wheel");
      Object.defineProperty(event, "deltaY", { value: -100 });
      pane.dispatchEvent(event);
      prefix = 100;
      height(1100);
      lease.owner.layout();
      for (let i = 0; i < 5; i++) flush();
      assertEquals(pane.scrollTop, 100);
    } finally {
      release();
      lease.release();
    }
  });
});

for (const movedBeforeLayout of [true, false]) {
  Deno.test(`active wheel preserves identity and input displacement across prepend (input first: ${movedBeforeLayout})`, () => {
    viewportFixture(({ pane, height, flush }) => {
      const lease = acquireViewport(pane);
      let prefix = 300;
      const release = lease.owner.register({
        id: "rows",
        depth: 1,
        anchor: () => ({ key: "row", offset: pane.scrollTop - prefix }),
        resolve: (anchor) => prefix + anchor.offset,
      });
      try {
        pane.scrollTop = 600;
        pane.dispatchEvent(new Event("scroll"));
        lease.owner.keepAnchor();
        for (let i = 0; i < 4; i++) flush();
        const wheel = new Event("wheel");
        Object.defineProperty(wheel, "deltaY", { value: -20 });
        pane.dispatchEvent(wheel);
        if (movedBeforeLayout) {
          pane.scrollTop = 580;
          pane.dispatchEvent(new Event("scroll"));
        }
        prefix += 1000;
        height(2400);
        lease.owner.layout();
        if (!movedBeforeLayout) pane.scrollTop = 580;
        // The native event can be delivered after the model/DOM prefix changes.
        pane.dispatchEvent(new Event("scroll"));
        for (let i = 0; i < 4; i++) flush();
        assertEquals(pane.scrollTop, 1580);
        pane.dispatchEvent(new Event("scrollend"));
        for (let i = 0; i < 4; i++) flush();
        assertEquals(pane.scrollTop, 1580);
      } finally {
        release();
        lease.release();
      }
    });
  });
}

Deno.test("a paged list's end is a reader position, not a tail to follow", () => {
  viewportFixture(({ pane, height, flush }) => {
    const lease = acquireViewport(pane);
    const release = lease.owner.register({
      id: "rows",
      depth: 1,
      anchor: () => ({ key: "row", offset: pane.scrollTop }),
      resolve: (anchor) => anchor.offset,
    });
    try {
      for (let i = 0; i < 4; i++) flush();
      pane.scrollTop = 900;
      pane.dispatchEvent(new Event("scroll"));
      const wheel = new Event("wheel");
      Object.defineProperty(wheel, "deltaY", { value: 100 });
      pane.dispatchEvent(wheel);
      // The demanded older page arrives below the row the reader is on.
      height(1100);
      lease.owner.layout();
      for (let i = 0; i < 5; i++) flush();
      assertEquals(pane.scrollTop, 900);
    } finally {
      release();
      lease.release();
    }
  }, { tail: false });
});

/** Controlled native event/frame order; assertions observe viewport position. */
function viewportFixture(
  run: (f: {
    pane: HTMLElement;
    height(value: number): void;
    resize(): void;
    flush(): void;
    writes(): number;
  }) => void,
  { tail = true } = {},
) {
  const names = [
    "document",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "ResizeObserver",
    "Element",
  ] as const;
  const saved = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  );
  let next = 0, resize = () => {};
  const frames = new Map<number, FrameRequestCallback>();
  class FixtureElement extends EventTarget {
    closest() {
      return null;
    }
  }
  class Pane extends FixtureElement {
    writes = 0;
    scrollHeight = 1000;
    clientHeight = 100;
    #top = 0;
    get scrollTop() {
      // Native clamping changes the stored offset; it cannot resurrect when a
      // later layout grows the scroll range again.
      this.#top = Math.min(this.#top, this.scrollHeight - this.clientHeight);
      return this.#top;
    }
    set scrollTop(value: number) {
      this.writes++;
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
      const id = ++next;
      frames.set(id, callback);
      return id;
    },
    (id: number) => {
      frames.delete(id);
    },
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
    FixtureElement,
  ];
  names.forEach((name, i) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: values[i],
    })
  );
  const owner = tail ? followViewport(pane, pane, () => {}) : undefined;
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  try {
    flush();
    assertEquals(pane.scrollTop, tail ? 900 : 0);
    run({
      pane,
      height: (value) => {
        (pane as unknown as Pane).scrollHeight = value;
      },
      resize: () => resize(),
      flush,
      writes: () => (pane as unknown as Pane).writes,
    });
  } finally {
    owner?.dispose();
    names.forEach((name, i) => {
      if (saved[i]) Object.defineProperty(globalThis, name, saved[i]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

Deno.test("explicit transcript position supersedes queued follow before or after its scroll notification", () => {
  for (const notify of [false, true]) {
    viewportFixture(({ pane, height, resize, flush }) => {
      // A genuine final layout change queues follow, then reveal moves the reader.
      height(1100);
      resize();
      pane.scrollTop = 200;
      if (notify) pane.dispatchEvent(new Event("scroll"));
      flush();
      assertEquals(pane.scrollTop, 200, `late scroll notification: ${!notify}`);
      // Programmatic movement preserves follow intent for subsequent new layout.
      height(1200);
      resize();
      flush();
      assertEquals(pane.scrollTop, 1100);
    });
  }
});

Deno.test("native geometry clamping is not a newer explicit transcript position", () => {
  viewportFixture(({ pane, height, resize, flush }) => {
    height(950);
    pane.dispatchEvent(new Event("scroll"));
    resize();
    flush();
    assertEquals(pane.scrollTop, 850);
    height(1100);
    resize();
    flush();
    assertEquals(pane.scrollTop, 1000);
  });
});

Deno.test("a pending reveal survives native clamping of the previous position", async () => {
  let result!: Promise<void>;
  viewportFixture(({ pane, flush }) => {
    const lease = acquireViewport(pane);
    try {
      result = lease.owner.navigate(
        () => ({ start: 200, end: 220, measured: true }),
        "start",
      );
      void result.catch(() => {});
      // Layout can shrink and grow the native range before its scroll event is
      // delivered. This is geometry, not a newer user navigation intent.
      pane.scrollTop = 800;
      pane.dispatchEvent(new Event("scroll"));
      flush();
      flush();
      flush();
      flush();
      assertEquals(pane.scrollTop, 200);
    } finally {
      lease.release();
    }
  });
  await result;
});

Deno.test("a queued native scroll cannot replace the anchor during a geometry transaction", () => {
  viewportFixture(({ pane, height, flush }) => {
    const lease = acquireViewport(pane);
    let prefix = 300;
    const release = lease.owner.register({
      id: "rows",
      depth: 1,
      anchor: () => ({ key: "row", offset: pane.scrollTop - prefix }),
      resolve: (anchor) => prefix + anchor.offset,
    });
    try {
      lease.owner.keepAnchor();
      prefix = 400;
      height(1100);
      lease.owner.layout();
      pane.scrollTop = 850;
      pane.dispatchEvent(new Event("scroll"));
      flush();
      flush();
      flush();
      flush();
      assertEquals(pane.scrollTop, 1000);
    } finally {
      release();
      lease.release();
    }
  });
});

Deno.test("measurement settlement keeps the requested row instead of rebasing to an estimated predecessor", () => {
  viewportFixture(({ pane, height, flush }) => {
    const lease = acquireViewport(pane);
    let first = true, rowStart = 957;
    const priorStart = 1837;
    const release = lease.owner.register({
      id: "rows",
      depth: 1,
      anchor: () =>
        first ? { key: "row", offset: -57 } : { key: "prior", offset: 63 },
      resolve: (anchor) =>
        (anchor.key === "row" ? rowStart : priorStart) + anchor.offset,
    });
    try {
      lease.owner.keepAnchor();
      first = false;
      rowStart = 1957;
      height(2200);
      lease.owner.layout();
      for (let i = 0; i < 5; i++) flush();
      assertEquals(pane.scrollTop, 1900);
      pane.dispatchEvent(new Event("scrollend"));
      for (let i = 0; i < 5; i++) flush();
      rowStart += 8;
      lease.owner.layout();
      for (let i = 0; i < 5; i++) flush();
      assertEquals(pane.scrollTop, 1908);
    } finally {
      release();
      lease.release();
    }
  });
});

for (const input of ["wheel", "keydown"]) {
  for (const endBeforeMovement of [false, true]) {
    Deno.test(`queued scrollend preserves ${input} through pending geometry (end before movement: ${endBeforeMovement})`, () => {
      viewportFixture(({ pane, flush }) => {
        const lease = acquireViewport(pane);
        const release = lease.owner.register({
          id: "rows",
          depth: 1,
          anchor: () => ({ key: "row", offset: pane.scrollTop }),
          resolve: (anchor) => anchor.offset,
        });
        try {
          for (let n = 0; n < 4; n++) flush();
          const event = new Event(input);
          Object.defineProperty(event, input === "wheel" ? "deltaY" : "key", {
            value: input === "wheel" ? -8 : "ArrowUp",
          });
          pane.dispatchEvent(event);
          lease.owner.layout();
          if (!endBeforeMovement) pane.scrollTop = 892;
          pane.dispatchEvent(new Event("scrollend"));
          if (endBeforeMovement) pane.scrollTop = 892;
          pane.dispatchEvent(new Event("scroll"));
          pane.dispatchEvent(new Event("scrollend"));
          for (let n = 0; n < 4; n++) flush();
          assertEquals(pane.scrollTop, 892);
        } finally {
          release();
          lease.release();
        }
      });
    });
  }
}
