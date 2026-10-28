// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";

/** Samples the caller's actual isolate; never discards startup/GC outliers. */
export function servingProbe(autoStart = true) {
  const samples: { name: string; ms: number; at: number }[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    if (timer !== undefined) return;
    let previous = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      samples.push({ name: "timer", ms: now - previous - 5, at: now });
      previous = now;
    }, 5);
  };
  if (autoStart) start();
  return {
    samples,
    start,
    section(name: string, ms: number) {
      samples.push({ name, ms, at: performance.now() });
    },
    stop() {
      clearInterval(timer);
    },
    assert() {
      assert(samples.length > 0);
      const bad = samples.filter((sample) => sample.ms >= 50);
      assert(
        bad.length === 0,
        `Serving isolate exceeded <50ms: ${JSON.stringify(bad)}`,
      );
    },
  };
}
