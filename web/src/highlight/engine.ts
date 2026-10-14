// SPDX-License-Identifier: LGPL-3.0-only
/** The native engine and its initialization resources belong to this worker. */
export async function instantiateOniguruma(imports?: WebAssembly.Imports) {
  const response = await fetch(
    new URL("../../../node_modules/shiki/dist/onig.wasm", import.meta.url),
  );
  if (!response.ok) {
    throw new Error(`Highlight engine asset: ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  // Delivery may be interrupted by immediate worker termination. Compilation
  // starts only with complete, worker-owned bytes; both constructors finish in
  // this turn, so no asynchronous streaming validator can outlive its isolate.
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), imports);
}
