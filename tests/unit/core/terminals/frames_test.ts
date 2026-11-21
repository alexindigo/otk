// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  encodeRequest,
  FrameDecoder,
  MAX_FRAME_BYTES,
} from "../../../../core/terminals/frames.ts";
import { test } from "../../../support/resources.ts";

function framed(body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(body.length + 4);
  new DataView(bytes.buffer).setUint32(0, body.length, false);
  bytes.set(body, 4);
  return bytes;
}
test("protocol-8 request envelope and safe bigint offsets round trip", () => {
  const value = encodeRequest("test-token", {
    op: "replay",
    id: 1,
    offset: 42n,
  });
  assertEquals(new DataView(value.buffer).getUint32(0), value.length - 4);
  assertEquals(JSON.parse(new TextDecoder().decode(value.subarray(4))), {
    token: "test-token",
    request: { op: "replay", id: 1, offset: 42 },
  });
  assertThrows(() =>
    encodeRequest("t", {
      op: "replay",
      id: 1,
      offset: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    })
  );
});
test("frame codec handles every split, multiple frames and raw u64 offsets", () => {
  const json = framed(
    new TextEncoder().encode(
      '{"type":"replay","requested_offset":42,"available_offset":42,"end_offset":45,"truncated":false,"data_base64":"YWJj"}',
    ),
  );
  const body = new Uint8Array(20), view = new DataView(body.buffer);
  view.setBigUint64(1, 1n << 60n);
  view.setBigUint64(9, (1n << 60n) + 3n);
  body.set([97, 98, 99], 17);
  const output = framed(body),
    combined = new Uint8Array(json.length + output.length);
  combined.set(json);
  combined.set(output, json.length);
  for (let split = 0; split <= combined.length; split++) {
    const decoder = new FrameDecoder();
    const frames = [
      ...decoder.push(combined.subarray(0, split)),
      ...decoder.push(combined.subarray(split)),
    ];
    assertEquals(frames.length, 2);
    assertEquals(
      frames[0].kind === "json" && frames[0].value.type === "replay" &&
        frames[0].value.end_offset,
      45n,
    );
    assertEquals(frames[1], {
      kind: "output",
      start: 1n << 60n,
      end: (1n << 60n) + 3n,
      bytes: new Uint8Array([97, 98, 99]),
    });
    decoder.finish();
  }
});
test("decoder rejects oversized lengths before body allocation and fails closed", () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_FRAME_BYTES + 1);
  const decoder = new FrameDecoder();
  assertThrows(() => decoder.push(header), Error, "length");
  assertThrows(() => decoder.push(new Uint8Array([0])), Error, "failed");
  assertThrows(
    () => new FrameDecoder().push(framed(new Uint8Array([0]))),
    Error,
    "output",
  );
  assertThrows(
    () =>
      new FrameDecoder().push(
        framed(
          new TextEncoder().encode(
            '{"type":"replay","end_offset":9007199254740993}',
          ),
        ),
      ),
    Error,
    "Unsafe",
  );
  const partial = new FrameDecoder();
  partial.push(new Uint8Array([0, 0]));
  assertThrows(() => partial.finish(), Error, "Truncated");
});
