// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  clientRequestPolicy,
  ConfigError,
  loadServiceConfig,
} from "../../../core/mod.ts";
import { cfg, defaultsPath } from "./support.ts";
import { test } from "../../support/resources.ts";

test("request policy layers all leaves and exports only the exact browser-safe subset", () => {
  const config = cfg();
  assertEquals(config.harness.requestms, 60000);
  assertEquals(config.requests.windowms, 86400000);
  assertEquals(
    Object.keys(clientRequestPolicy(config)).sort(),
    [
      "httpms",
      "inputbytes",
      "livenessms",
      "maxpending",
      "pingms",
      "resumebatch",
      "retrybase",
      "retrymax",
      "silencems",
      "stoppingms",
    ].sort(),
  );
  const result = loadServiceConfig({
    defaultsPath,
    env: {
      OTK_REQUESTS_LIVENESSMS: "40000",
      OTK_CONNECTION_RETRYBASE: "20",
      OTK_HARNESS_REQUESTMS: "70000",
    },
  }).config;
  assertEquals(result.requests.livenessms, 40000);
  assertEquals(result.harness.requestms, 70000);
  assertEquals(result.connection.retrybase, 20);
});
test("request policy rejects infeasible and nonpositive values with aggregated node/env diagnostics", () => {
  const error = assertThrows(() =>
    loadServiceConfig({
      defaultsPath,
      env: {
        OTK_REQUESTS_INPUTBYTES: "1",
        OTK_REQUESTS_RETENTIONMS: "0",
        OTK_CONNECTION_RETRYBASE: "40000",
        OTK_CONNECTION_SILENCEMS: "20000",
        OTK_HARNESS_REQUESTMS: "0",
      },
    }), ConfigError);
  assertEquals(error.problems.length, 5);
  for (
    const node of [
      "INPUTBYTES",
      "RETENTIONMS",
      "RETRYMAX",
      "SILENCEMS",
      "REQUESTMS",
    ]
  ) assert(error.problems.some((problem) => problem.includes(node)));
});
