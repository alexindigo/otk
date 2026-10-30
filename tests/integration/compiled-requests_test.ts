// SPDX-License-Identifier: LGPL-3.0-only
import { qualifyRequestRestart } from "../support/request-restart.ts";
import { test } from "../support/resources.ts";

test("compiled request receipts replay off-source after lost delivery and keep a lost native outcome uncertain", async () => {
  await qualifyRequestRestart(true);
});
