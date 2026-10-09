// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  commandOptions,
  parseCommand,
} from "../../web/src/ui/prompt/autocomplete.ts";
Deno.test("slash ranking gives trigger-inclusive name prefixes priority over description matches", () => {
  assertEquals(
    commandOptions([
      {
        name: "probe",
        description: "A project command",
        source: "server",
        aliases: [],
      },
      { name: "apro", description: "pro", source: "server", aliases: [] },
    ], "pro")[0].command?.name,
    "probe",
  );
});
Deno.test("command arguments retain first-line spacing and all subsequent lines; descriptions and aliases match", () => {
  assertEquals(parseCommand("/probe a  b\nsecond\nthird"), {
    command: "probe",
    arguments: "a  b\nsecond\nthird",
  });
  assertEquals(parseCommand("ordinary prompt"), undefined);
  assertEquals(
    commandOptions([{
      name: "probe",
      description: "Useful fixture",
      source: "server",
      aliases: ["canary"],
    }], "canary")[0].command?.name,
    "probe",
  );
  assertEquals(
    commandOptions([{
      name: "probe",
      description: "Useful fixture",
      source: "server",
      aliases: [],
    }], "Useful")[0].command?.name,
    "probe",
  );
});
