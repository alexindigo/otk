// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  terminalGroup,
  terminalOwner,
  terminalRunning,
} from "../../../../core/terminals/ownership.ts";
import { process } from "./fixture.ts";

Deno.test("terminal ownership has one strict versioned checkout/session codec", () => {
  const owner = {
    dir: "/workspace/with spaces/日本語",
    session: "tstv1-owner",
  };
  const encoded = terminalGroup(owner);
  assertEquals(terminalOwner(encoded), owner);
  for (
    const group of [
      "tstv1-owner",
      "otk2:" + encoded.slice(5),
      "otk1:!",
      encoded + "=",
      "otk1:e30",
    ]
  ) {
    assertEquals(terminalOwner(group), undefined);
  }
  assertThrows(() =>
    terminalGroup({ dir: "relative", session: owner.session })
  );
  assertThrows(() => terminalGroup({ ...owner, session: "unqualified" }));
});

Deno.test("running means a positive foreground name other than the shell, never PTY liveness", () => {
  assertEquals(terminalRunning(process()), true);
  assertEquals(terminalRunning(process("bash")), false);
  assertEquals(terminalRunning(process("-bash")), false);
  assertEquals(terminalRunning(process(null)), false);
  assertEquals(
    terminalRunning({
      ...process(),
      lifecycle: { status: "exited", exit_code: 0 },
    }),
    false,
  );
  assertEquals(
    terminalRunning({
      ...process(),
      lifecycle: { status: "failed", message: "spawn" },
    }),
    false,
  );
  assertEquals(terminalRunning({ ...process(), mode: "pipe" }), false);
  assertEquals(
    terminalRunning({
      ...process("long-shell-name"),
      command: ["/bin/long-shell-name-extra"],
    }),
    false,
  );
});
