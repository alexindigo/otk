// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { metadataRecord } from "../components/parts/metadata-record.ts";
import { unknownPartPreview } from "../components/parts/unknown-part.ts";

Deno.test("legacy bookkeeping is a visible inspectable record without losing fields", () => {
  const part = {
    kind: "step" as const,
    id: "step",
    phase: "finish" as const,
    cost: 0.25,
  };
  const record = metadataRecord(part);
  assertEquals(record.activity?.category, "record");
  assertEquals(record.activity?.title, "Step finished");
  assertEquals(JSON.parse(unknownPartPreview(record)!.text), part);
  const source = {
    kind: "fixture/step",
    preview: "native",
    bytes: 42,
    truncated: true,
    payload: "exact",
  };
  assertEquals(metadataRecord({ ...part, source }).source, source);
  assertEquals(
    metadataRecord({ kind: "meta", id: "meta" }).activity?.title,
    "Metadata",
  );
});
