// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { SessionIndex } from "@otk/harness";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import { FakeLlm } from "../../support/fake-llm.ts";
import { waitFor } from "../../support/opencode.ts";
import {
  nativeDigest,
  nativeHarness,
  selectedNative,
  startHarness,
} from "../../support/native-testing.ts";
import { resources, tempDir, test } from "../../support/resources.ts";

test("accepted deletion before catalog seeds retained metadata and survives restart without provider health", async () => {
  const root = await tempDir("new-deletion-"),
    fake = new FakeLlm(),
    oc = await selectedNative(fake);
  const session = await oc.createSession("Deleted before catalog");
  const harness = nativeHarness(oc);
  resources().defer("deletion metadata adapter", () => harness.core.stop());
  await startHarness(harness);
  const raw = await harness.core.getSession(session.id);
  const metadata = {
    id: raw.id,
    title: raw.title,
    directory: raw.directory,
    projectID: raw.projectID,
    parentID: raw.parentID,
    timeCreated: raw.time.created,
    timeUpdated: raw.time.updated,
    archived: raw.archived,
    status: "idle" as const,
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  await harness.capabilities.sessionActions!.remove(session.id);
  await oc.stop();
  let index = new SessionIndex();
  const diagnostics: Error[] = [];
  const open = () =>
    new DigestBridge({
      statePath: join(root, "state"),
      ...nativeDigest(oc),
      policy: {
        batch: 100,
        slicems: 8,
        cpu: 1,
        memoryreserve: 1,
        maxpending: 512,
        idlems: 1,
        parallel: 3,
        background: false,
        publishrows: 64,
        retryms: 10,
        busyms: 100,
      },
      metadata(entries) {
        for (const entry of entries) index.upsertMetadata(entry);
      },
      publish(value) {
        index.applyDigest({
          id: value.sessionID,
          revision: value.revision,
          ...value.delta,
        });
      },
      diagnostic: (error) => diagnostics.push(error),
    });
  let bridge = open();
  resources().defer("new deletion bridge", () => bridge.stop());
  await bridge.start();
  const deleted = Reflect.get(bridge, "deleted");
  await Reflect.apply(deleted, bridge, [0, metadata.id, 1, metadata]);
  await waitFor(
    () => index.get(metadata.id),
    (entry) => entry?.deleted?.how === "provider",
    2000,
  );
  assertEquals(index.get(metadata.id)!.title, metadata.title);
  assertEquals(index.get(metadata.id)!.digest.messageCount, undefined);
  assertEquals(diagnostics, []);
  await bridge.stop();
  index = new SessionIndex();
  bridge = open();
  await bridge.start();
  // Q1 restores retained tombstones only for explicitly demanded identities.
  await bridge.hydrate([metadata.id], new AbortController().signal, true);
  await waitFor(
    () => index.get(metadata.id),
    (entry) => entry?.deleted?.how === "provider",
    2000,
  );
  assertEquals(index.get(metadata.id)!.title, metadata.title);
  assertEquals(diagnostics, []);
  await bridge.stop();
  assertEquals(diagnostics, []);
});
