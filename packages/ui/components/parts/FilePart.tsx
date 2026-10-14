// SPDX-License-Identifier: LGPL-3.0-only
import type { Part } from "@otk/protocol";
type FilePart = Extract<Part, { kind: "file" }>;
import type { PartRegistry } from "../../registries/renderers.ts";
export function registerFilePart(parts: PartRegistry): void {
  parts.register(
    "file",
    (props) => (
      <span class="otk-chip" title={(props.part as FilePart).path}>
        {(props.part as FilePart).mime === "application/x-directory"
          ? "Directory"
          : "File"}: {(props.part as FilePart).name}
      </span>
    ),
  );
}
