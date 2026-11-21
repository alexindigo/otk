// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  daemonEnvironment,
  hasSystemd,
  shellEnvironment,
  shellProgram,
  terminalDataDirectory,
} from "../../../../core/terminals/env.ts";
import { tempDir, test } from "../../../support/resources.ts";

test("shell and daemon environments have independent injected projections", async () => {
  const source = {
    HOME: "/home/tester",
    PATH: "/bin",
    SHELL: "/bin/bash",
    USER: "tester",
    LANG: "C",
    LC_ALL: "C",
    XDG_DATA_HOME: "/data",
    OTK_SECRET: "private",
    OTK_TERMINAL: "wrong",
    INVOCATION_ID: "systemd",
    JOURNAL_STREAM: "stream",
    NOTIFY_SOCKET: "socket",
    OTHER: "kept",
  };
  assertEquals(daemonEnvironment(source), {
    HOME: "/home/tester",
    PATH: "/bin",
    USER: "tester",
    LANG: "C",
    LC_ALL: "C",
    XDG_DATA_HOME: "/data",
  });
  assertEquals(shellEnvironment(source), {
    HOME: "/home/tester",
    PATH: "/bin",
    USER: "tester",
    SHELL: "/bin/bash",
    LANG: "C",
    LC_ALL: "C",
    XDG_DATA_HOME: "/data",
    OTHER: "kept",
    OTK_TERMINAL: "1",
  });
  assertEquals(await shellProgram(source), "/bin/bash");
  assertEquals(await shellProgram({}), "/bin/sh");
  const bin = await tempDir("terminal-shell-");
  await Deno.writeTextFile(
    `${bin}/getent`,
    "#!/bin/sh\nprintf 'root:x:0:0:root:/root:/bin/sh\\n'\n",
    { mode: 0o755 },
  );
  assertEquals(
    await shellProgram({ USER: "root", PATH: bin }),
    "/bin/sh",
  );
  assertEquals(terminalDataDirectory(source), "/data/otk");
  assertEquals(
    terminalDataDirectory({ HOME: "/home/tester" }),
    "/home/tester/.local/share/otk",
  );
  assertThrows(() => terminalDataDirectory({ XDG_DATA_HOME: "relative" }));
  assertEquals(
    terminalDataDirectory({ XDG_DATA_HOME: "relative", HOME: "/home/tester" }),
    "/home/tester/.local/share/otk",
  );
  assertEquals(await hasSystemd({ PATH: "/usr/bin" }), false);
  assertEquals(
    await hasSystemd({ PATH: "/does-not-exist", INVOCATION_ID: "test" }),
    false,
  );
});
