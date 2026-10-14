// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";

async function initialize(mode: string) {
  const worker = new Worker(
    new URL("./highlight-initialization-worker.ts", import.meta.url),
    { type: "module" },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{
      type: string;
      name?: string;
      message?: string;
      match?: {
        index: number;
        captureIndices: { start: number; end: number }[];
      };
    }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${mode} timed out`)), 5000);
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new Error(event.message));
      };
      worker.postMessage(mode);
    });
    if (mode === "interrupted") assertEquals(result.type, "held");
    else if (mode === "ready") {
      assertEquals(result.type, "ready");
      assert(result.match);
      assertEquals(result.match.index, 0);
      assertEquals(result.match.captureIndices[0].start, 0);
      assertEquals(result.match.captureIndices[0].end, 5);
    } else {
      assertEquals(result.type, "error");
      assertEquals(
        result.name,
        mode === "compile-error"
          ? "CompileError"
          : mode === "instantiate-error"
          ? "LinkError"
          : "Error",
      );
      if (mode === "http-error") {
        assertEquals(result.message, "Highlight engine asset: 404");
      }
      if (mode === "delivery-error") {
        assertEquals(result.message, "Engine delivery failed");
      }
    }
    console.log(`INITIALIZATION ${mode} observed`);
  } finally {
    // Immediate termination at the observed boundary, never a grace period.
    worker.terminate();
    clearTimeout(timer);
    console.log(`INITIALIZATION ${mode} terminated`);
  }
}

for (
  const mode of [
    "interrupted",
    "delivery-error",
    "http-error",
    "compile-error",
    "instantiate-error",
  ]
) {
  await initialize(mode);
  // A fresh real native scanner must be usable after every interrupted/error leg.
  await initialize("ready");
}
console.log("INITIALIZATION_ALL_OBSERVED");
