// SPDX-License-Identifier: LGPL-3.0-only
import "./LiveCount.css" with { type: "text" };
import { type EntityStateStore, lamp } from "@otk/client";
import StatusLight from "./StatusLight.tsx";
import ChromeMeta from "./ChromeMeta.tsx";

/** Layout shared by the composer's work pills. */
export default function LiveCount(props: {
  entities?: EntityStateStore;
  lampKey?: string;
  label: string;
}) {
  return (
    <span class="otk-live-count is-full">
      <StatusLight small state={lamp(props.entities, props.lampKey)} />
      <ChromeMeta class="otk-control-label">{props.label}</ChromeMeta>
    </span>
  );
}
