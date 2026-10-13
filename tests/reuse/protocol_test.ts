// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  checkClientFrameSize,
  type ClientFrame,
  type ContentOp,
  isAttentionOp,
  PROTOCOL_VERSION,
  type ServerFrame,
} from "@otk/protocol";

Deno.test("standalone protocol consumer builds and receives wire frames without app dependencies", () => {
  const hello: ClientFrame = { t: "hello", protocol: PROTOCOL_VERSION };
  const serialized = JSON.stringify(hello);
  checkClientFrameSize(serialized);
  assertEquals(serialized, '{"t":"hello","protocol":10}');
  const event: ContentOp = {
    op: "permission.remove",
    requestID: "request",
    sessionID: "session",
  };
  const frame: ServerFrame = { t: "content", sessionID: "session", event };
  const received = JSON.parse(JSON.stringify(frame)) as ServerFrame;
  assertEquals(received, frame);
  if (received.t === "content") {
    assertEquals(isAttentionOp(received.event), true);
  }
});
