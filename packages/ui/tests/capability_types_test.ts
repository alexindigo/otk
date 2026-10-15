// SPDX-License-Identifier: LGPL-3.0-only
import type { CapabilityName, ServerFrame } from "@otk/protocol";
import type { SidecarConnection, SidecarState } from "@otk/client";
import type { DockDefinition } from "../registries/renderers.ts";
import type SessionView from "../components/SessionView.tsx";
import type Docks from "../components/Docks.tsx";

// Compile-only contracts prove all consumers reject misspelled names. These
// generic assertions have no runtime side effects or dependency on mounted UI.
type Assert<T extends true> = T;
type RejectsTypo<T> = "permisssions" extends T ? false : true;
export type CapabilityTypeChecks = [
  Assert<RejectsTypo<CapabilityName>>,
  Assert<RejectsTypo<Parameters<SidecarConnection["supports"]>[0]>>,
  Assert<RejectsTypo<SidecarState["capabilities"][number]>>,
  Assert<RejectsTypo<DockDefinition["capability"]>>,
  Assert<
    RejectsTypo<Parameters<typeof SessionView>[0]["capabilities"][number]>
  >,
  Assert<RejectsTypo<Parameters<typeof Docks>[0]["capabilities"][number]>>,
  Assert<
    RejectsTypo<
      NonNullable<
        Extract<
          ServerFrame,
          { t: "welcome" }
        >["sidecar"]["harness"]["capabilities"]
      >[number]
    >
  >,
];
