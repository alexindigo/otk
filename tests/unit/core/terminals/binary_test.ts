// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  binaryFromTar,
  requireHash,
  verifyArchive,
} from "../../../../scripts/fetch-opencode-pty.ts";
import {
  embeddedPtyBinary,
  manifestForCurrentTarget,
  resolvePtyBinary,
  sha256Hex,
} from "../../../../core/terminals/binary.ts";
import { tempDir, test } from "../../../support/resources.ts";

test("pinned manifest refuses placeholders, unsupported targets and corrupt integrity", async () => {
  assertThrows(() => requireHash("RECORD"), Error, "sha256");
  assertThrows(
    () => manifestForCurrentTarget("unsupported"),
    Error,
    "Unsupported",
  );
  assertThrows(() => binaryFromTar(new Uint8Array(512)), Error, "missing");
  await assertRejects(
    () => verifyArchive(new Uint8Array([1]), "sha512-invalid"),
    Error,
    "integrity",
  );
});
test("embedded binary extracts atomically, verifies reuse and repairs altered bytes", async () => {
  const dir = await tempDir("pty-binary-");
  const manifest = manifestForCurrentTarget();
  const binary = await resolvePtyBinary(dir, embeddedPtyBinary());
  assertEquals(
    binary,
    join(
      dir,
      "opencode-pty",
      `0.5.0-${manifest.sha256.slice(0, 16)}`,
      "opencode-pty",
    ),
  );
  assertEquals(await sha256Hex(await Deno.readFile(binary)), manifest.sha256);
  assertEquals((await Deno.stat(binary)).mode! & 0o777, 0o755);
  const before = (await Deno.stat(binary)).ino;
  assertEquals(
    await resolvePtyBinary(dir, toFileUrl(join(dir, "missing"))),
    binary,
  );
  assertEquals((await Deno.stat(binary)).ino, before);
  await Deno.writeFile(binary, new Uint8Array([0]));
  await resolvePtyBinary(dir, embeddedPtyBinary());
  assertEquals(await sha256Hex(await Deno.readFile(binary)), manifest.sha256);
  const corrupt = join(dir, "corrupt");
  await Deno.writeTextFile(corrupt, "wrong");
  await assertRejects(
    () => resolvePtyBinary(join(dir, "other"), toFileUrl(corrupt)),
    Error,
    "checksum",
  );
  assertEquals(
    await resolvePtyBinary(dir, embeddedPtyBinary(), "/usr/bin/test-override"),
    "/usr/bin/test-override",
  );
  await assertRejects(
    () => resolvePtyBinary(dir, embeddedPtyBinary(), "relative"),
    Error,
    "absolute",
  );
});
