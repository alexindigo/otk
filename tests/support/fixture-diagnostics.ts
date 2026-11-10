// SPDX-License-Identifier: LGPL-3.0-only
import { Console } from "node:console";
import { stderr } from "node:process";

// Imported first by the controller, before any fixture/application module runs.
// Every Console method shares stderr; only framed responses use Deno.stdout.
globalThis.console = new Console({ stdout: stderr, stderr });

// Custody exists before profile admission or native-module initialization can
// fail. Later successful acquisitions replace this with their complete inventory.
const ownership = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
if (ownership) {
  Deno.writeTextFileSync(
    ownership,
    JSON.stringify({ pids: [Deno.pid], ports: [] }),
  );
}
