// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { assertIdentityFields } from "../support/identity-assertions.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { test } from "../support/resources.ts";
import { nativeKind, nativeVersion } from "../support/native.ts";
import { nativeDigest } from "../support/native-testing.ts";
import { cfg } from "../support/config.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { DigestBridge } from "../../core/digest/bridge.ts";
import { SessionHierarchy } from "../../core/index/session-hierarchy.ts";

test(`native ${nativeVersion}: moved children retain their family, local anchor and sibling navigation`, async () => {
  const fake = new FakeLlm();
  const oc = nativeKind === "opencode-v2-server"
    ? await OpencodeV2Test.start(fake)
    : await OpencodeTest.start(fake);
  const parent = await oc.createSession("Repo parent");
  const directory = oc.directory + "/tree";
  await Deno.mkdir(directory);
  let childID: string;
  if (oc instanceof OpencodeV2Test) {
    const child = await oc.api.session.create({
      parentID: parent.nativeID,
      title: "Moved helper",
    });
    await oc.api.session.move({ sessionID: child.id, directory });
    const moved = await waitFor(
      () => oc.api.session.get({ sessionID: child.id }),
      (row) => row.location.directory === directory,
    );
    assertEquals(moved.parentID, parent.nativeID);
    childID = `opcv2-${child.id}`;
  } else {
    const child = await oc.session<
      { id: string; directory: string; parentID: string }
    >("/session", {
      method: "POST",
      directory,
      body: { title: "Cross-directory helper", parentID: parent.id },
    });
    assertEquals(child.directory, directory);
    assertEquals(child.parentID, parent.id);
    childID = child.id;
  }
  // Exercise the public worker read port, not a package-private SQL reader.
  const bridge = new DigestBridge({
    statePath: oc.root + "/hierarchy",
    ...nativeDigest(oc),
    policy: cfg().digest,
    publish() {},
  });
  const options = {
    owner: "session-hierarchy-proof",
    priority: "user" as const,
  };
  try {
    assertIdentityFields(
      await bridge.read("identity.batch", { ids: [childID] }, options),
      [
        { id: childID, directory, parentID: parent.id },
      ],
    );
    assertEquals(
      (await bridge.read("sessions.list", {
        directory,
        parentID: null,
        limit: 1,
      }, options)).items,
      [],
    );
    const local = await bridge.read(
      "sessions.list",
      { directory, limit: 20 },
      options,
    );
    assertEquals(local.items.map((row) => row.id), [childID]);
    const siblings = await bridge.read("sessions.list", {
      directory: oc.directory,
      parentID: parent.id,
      limit: 20,
    }, options);
    assertEquals(siblings.items.map((row) => row.id), [childID]);
    const hierarchy = new SessionHierarchy();
    await hierarchy.prepare(
      local.items,
      (ids, signal) =>
        bridge.read("identity.batch", { ids: [...ids] }, {
          ...options,
          signal,
        }),
    );
    assertEquals(hierarchy.node(childID)?.rootID, parent.id);
    assertEquals(hierarchy.node(childID)?.anchorID, childID);
    console.info(
      JSON.stringify({
        version: nativeVersion,
        childID,
        parentID: parent.id,
        childDirectory: directory,
        parentDirectory: oc.directory,
        rootsInChildDirectory: 0,
        siblingIDs: siblings.items.map((row) => row.id),
      }),
    );
  } finally {
    await bridge.stop();
  }
});
