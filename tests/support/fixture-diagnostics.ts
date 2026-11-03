// SPDX-License-Identifier: LGPL-3.0-only
import { Console } from "node:console";
import { stderr } from "node:process";

// Imported first by the controller, before any fixture/application module runs.
// Every Console method shares stderr; only framed responses use Deno.stdout.
globalThis.console = new Console({ stdout: stderr, stderr });
