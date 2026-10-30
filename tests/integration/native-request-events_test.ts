// SPDX-License-Identifier: LGPL-3.0-only
import { qualifyRequestRestart } from "../support/request-restart.ts";
import { test } from "../support/resources.ts";

test("stock native effect survives OTK process replacement without a second dispatch", async () => {
  await qualifyRequestRestart(false);
});
