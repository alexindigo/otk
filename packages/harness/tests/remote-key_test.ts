// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { readSshAliases, remoteKey } from "../remote-key.ts";

Deno.test("remote keys ignore transport and credentials but retain repository identity", () => {
  const aliases = new Map([
    ["github-thrudhame", "github.com"],
    ["aur-atmosphera", "aur.archlinux.org"],
  ]);
  const key = (url: string) => remoteKey(url, "/srv/git/checkout", aliases);
  for (
    const url of [
      "git@github.com:AlexIndigo/otk.git",
      "https://github.com/alexindigo/otk",
      "https://user:token@github.com/alexindigo/otk.git/",
      "ssh://git@github.com:22/alexindigo/otk.git",
      "git+ssh://git@github.com/alexindigo/otk.git",
      "git://github.com:9418/alexindigo/otk.git",
      "http://GITHUB.COM:80//alexindigo//otk.git?token=secret",
    ]
  ) {
    assertEquals(key(url), {
      key: "github.com/alexindigo/otk",
      host: "github.com",
      owner: "alexindigo",
    });
  }
  assertEquals(key("git@github-thrudhame:thrudhame/communico.git"), {
    key: "github.com/thrudhame/communico",
    host: "github.com",
    owner: "thrudhame",
  });
  assertEquals(key("aur-atmosphera:atmosphera.git"), {
    key: "aur.archlinux.org/atmosphera",
    host: "aur.archlinux.org",
  });
  assertEquals(key("ssh://aur@aur.archlinux.org/qt6-niriqml.git"), {
    key: "aur.archlinux.org/qt6-niriqml",
    host: "aur.archlinux.org",
  });
  assertEquals(key("ssh://git@EXAMPLE.org:2222/~git//Case/Repo.git/"), {
    key: "example.org:2222/Case/Repo",
    host: "example.org",
  });
  for (const url of ["/srv/git/x.git", "../x", "file:///srv/git/x.git"]) {
    assertEquals(key(url), { key: "file:/srv/git/x", host: "" });
  }
  for (
    const url of ["", "https://github.com/", "ext::command", "ssh://bad host/x"]
  ) {
    assertEquals(key(url), null);
  }
});

Deno.test("SSH aliases read literal Host blocks and includes without running any process", async () => {
  const home = await Deno.makeTempDir();
  const Command = Deno.Command;
  let calls = 0;
  Deno.Command = new Proxy(Command, {
    construct() {
      calls++;
      throw new Error("SSH config must be parsed, not executed");
    },
  });
  try {
    const ssh = join(home, ".ssh");
    await Deno.mkdir(join(ssh, "conf.d"), { recursive: true });
    await Deno.writeTextFile(
      join(ssh, "config"),
      `
      Host *
        HostName wildcard.invalid
      Include "conf.d/*.conf" missing.conf
      Host GITHUB-THRUDHAME a-second-name
        HostName=github.com
      Host github-thrudhame
        HostName later.invalid
      Match exec "must not run"
        HostName match.invalid
    `,
    );
    await Deno.writeTextFile(
      join(ssh, "conf.d", "aur.conf"),
      `
      Include ~/.ssh/config
      Host aur-atmosphera aur-* !aur-other
        HostName "aur.archlinux.org"
    `,
    );
    assertEquals(
      await readSshAliases(home),
      new Map([
        ["aur-atmosphera", "aur.archlinux.org"],
        ["github-thrudhame", "github.com"],
        ["a-second-name", "github.com"],
      ]),
    );
    assertEquals(calls, 0);
  } finally {
    Deno.Command = Command;
    await Deno.remove(home, { recursive: true });
  }
});
