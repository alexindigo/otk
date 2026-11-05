// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertFalse } from "@std/assert";
import { isCancellation, StoppedError } from "@otk/protocol";
import { diagnosticsLog } from "../../../core/diagnostics-log.ts";
import { ConfigError, loadServiceConfig } from "../../../core/config/loader.ts";
import { defaultsPath, fixture } from "./support.ts";
import { assertThrows } from "@std/assert";
import { test } from "../../support/resources.ts";
import { join } from "@std/path";

test("diagnostics owns cancellation, level filtering and once-only failure reporting", () => {
  const output: unknown[] = [];
  const log = diagnosticsLog("info", (...args) => output.push(args));
  const stopped = new StoppedError("stopped");
  const abort = new DOMException("cancelled", "AbortError");
  assertEquals(isCancellation(stopped), true);
  assertEquals(isCancellation(abort), true);
  assertFalse(isCancellation({ name: "AbortError" }));
  assertFalse(isCancellation(new Error("real failure")));
  log("warn", "stop", stopped);
  log("warn", "abort", abort);
  log("debug", "hidden");
  log("info", "lifecycle");
  const failure = new Error("disk failed");
  log("warn", "worker", failure);
  log("warn", "startup", new AggregateError([stopped, failure], "cleanup"));
  assertEquals(output, [["info", "lifecycle"], [
    "warn",
    "worker: disk failed",
  ]]);
  diagnosticsLog("debug", (...args) => output.push(args))("debug", "visible");
  assertEquals(output.at(-1), ["debug", "visible"]);
});

test("log level layers from info through operator config to environment", async () => {
  const overlayPath = join(await fixture(), "log.toml");
  await Deno.writeTextFile(overlayPath, '[log]\nlevel="warn"\n');
  assertEquals(
    loadServiceConfig({ defaultsPath, env: {} }).config.log.level,
    "info",
  );
  assertEquals(
    loadServiceConfig({ defaultsPath, overlayPath, env: {} }).config.log.level,
    "warn",
  );
  assertEquals(
    loadServiceConfig({
      defaultsPath,
      overlayPath,
      env: { OTK_LOG_LEVEL: "debug" },
    }).config.log.level,
    "debug",
  );
  assertThrows(
    () => loadServiceConfig({ defaultsPath, env: { OTK_LOG_LEVEL: "trace" } }),
    ConfigError,
    "OTK_LOG_LEVEL",
  );
});
