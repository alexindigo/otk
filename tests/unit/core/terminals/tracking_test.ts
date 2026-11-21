// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { TerminalTracking } from "../../../../core/terminals/tracking.ts";
import type { Response } from "../../../../core/terminals/frames.ts";
import { process } from "./fixture.ts";

Deno.test("terminal tracking coalesces inventories, counts owners and checkouts, and fences late mutations", async () => {
  let complete!: (reply: Response) => void;
  let requests = 0, scheduled = 0;
  const pending = new Promise<Response>((resolve) => complete = resolve);
  const a = process(),
    b = { ...process("less", "/workspace", "tstv1-second"), id: 2 };
  const c = { ...process("bash"), id: 3 };
  const inventory = new TerminalTracking(
    (cause) => {
      throw cause;
    },
    2,
    {
      schedule(_run, ms) {
        assertEquals(ms, 2000);
        scheduled++;
        return () => scheduled--;
      },
    },
  );
  const daemon = {
    alive: true,
    request: () => {
      requests++;
      return requests === 1
        ? pending
        : Promise.resolve({ type: "processes", processes: [b, c] } as Response);
    },
  };
  const binding = inventory.bind(daemon);
  await Promise.resolve();
  const mutation = inventory.changed();
  complete({ type: "processes", processes: [a, b] });
  await Promise.all([binding, mutation]);
  assertEquals(requests, 2);
  assertEquals([...inventory.counts.sessions], [["tstv1-second", 1]]);
  assertEquals([...inventory.counts.checkouts], [["/workspace", 1]]);
  assertEquals(scheduled, 1);
  await inventory.stop();
  assertEquals(scheduled, 0);
  assertEquals(inventory.processes, []);
  await inventory.refresh();
  assertEquals(requests, 2);
});

Deno.test("tracking retains evidence on transient failure and cancels/joins held daemon I/O", async () => {
  let calls = 0, errors = 0, cancelled = false;
  const inventory = new TerminalTracking(() => errors++, 128, {
    schedule: () => () => {},
  });
  await inventory.bind({
    alive: true,
    request: (_request, signal) => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({ type: "processes", processes: [process()] });
      }
      if (calls === 2) {
        return Promise.reject(new Error("transient"));
      }
      return new Promise((_resolve, reject) =>
        signal!.addEventListener("abort", () => {
          cancelled = true;
          reject(new Error("cancelled"));
        }, { once: true })
      );
    },
  });
  await inventory.refresh();
  assertEquals(errors, 1);
  assertEquals(inventory.counts.checkouts.get("/workspace"), 1);
  const held = inventory.refresh();
  await Promise.resolve();
  await inventory.stop();
  await held;
  assertEquals(cancelled, true);
  assertEquals(errors, 1);
  assertEquals(inventory.counts.checkouts.size, 0);
});
