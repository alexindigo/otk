// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertFalse } from "@std/assert";
import { isCancellation, StoppedError } from "@otk/protocol";
import { diagnosticsLog } from "../../../core/diagnostics-log.ts";
import { ConfigError, loadServiceConfig } from "../../../core/config/loader.ts";
import { defaultsPath, fixture } from "./support.ts";
import { assertThrows } from "@std/assert";
import { test } from "../../support/resources.ts";
import { join } from "@std/path";

test("all diagnostic levels use stderr, leaving protocol stdout empty", async () => {
  const module =
    new URL("../../../core/diagnostics-log.ts", import.meta.url).href;
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `import { diagnosticsLog } from ${
        JSON.stringify(module)
      }; const log = diagnosticsLog("debug"); for (const level of ["warn", "info", "debug"]) log(level, level);`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0);
  assertEquals(new TextDecoder().decode(result.stdout), "");
  assertEquals(new TextDecoder().decode(result.stderr), "warn\ninfo\ndebug\n");
});

test("store startup sends effective settings once through the injected diagnostics owner", async () => {
  const module =
    new URL("../../../core/diagnostics-log.ts", import.meta.url).href;
  const store = new URL("../../../packages/store/mod.ts", import.meta.url).href;
  const root = await fixture();
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `import { diagnosticsLog } from ${
        JSON.stringify(module)
      }; import { OtkDb, DigestDb } from ${
        JSON.stringify(store)
      }; const log = diagnosticsLog("info"); const options = {busyms: 0, diagnostic: message => log("info", message)}; new OtkDb(${
        JSON.stringify(root)
      }, [], options).close(); new DigestDb(${
        JSON.stringify(root)
      }, [], options).close();`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0);
  assertEquals(new TextDecoder().decode(result.stdout), "");
  const lines = new TextDecoder().decode(result.stderr).trim().split("\n");
  assertEquals(lines.length, 1);
  assertEquals(lines[0].startsWith("SQLite settings "), true);
  const settings = JSON.parse(lines[0].slice("SQLite settings ".length));
  assertEquals(settings.mmap_size, 0);
  assertEquals(typeof settings.version, "string");
});

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
