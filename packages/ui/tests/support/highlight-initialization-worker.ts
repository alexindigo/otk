// SPDX-License-Identifier: LGPL-3.0-only
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { instantiateOniguruma } from "../../highlight/engine.ts";

globalThis.onmessage = ({ data }: MessageEvent<string>) => {
  const mode = data;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (mode === "delivery-error") throw new Error("Engine delivery failed");
    if (mode === "http-error") return new Response(null, { status: 404 });
    if (mode === "compile-error") return new Response(new Uint8Array([0]));
    const response = await nativeFetch(...args);
    if (mode !== "interrupted") return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    let first = true;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(bytes.slice(0, 65536));
          } else {
            globalThis.postMessage({ type: "held" });
            return new Promise<void>(() => {});
          }
        },
      }, { highWaterMark: 0 }),
    );
  };
  void (async () => {
    if (mode === "instantiate-error") {
      await instantiateOniguruma({ env: {}, wasi_snapshot_preview1: {} });
      throw new Error("Invalid imports were accepted");
    }
    const engine = await createOnigurumaEngine(instantiateOniguruma);
    const scanner = engine.createScanner(["const"]);
    try {
      const match = scanner.findNextMatchSync("const genuine = 1;", 0, 0);
      globalThis.postMessage({ type: "ready", match });
    } finally {
      scanner.dispose?.();
    }
  })().catch((error) => {
    globalThis.postMessage({
      type: "error",
      name: error.name,
      message: error.message,
    });
  });
};
