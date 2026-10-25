// SPDX-License-Identifier: LGPL-3.0-only
import "./DividerLabel.css" with { type: "text" };
/** One flowing label/rule pattern shared by transcript disclosures and markers. */
export default function DividerLabel(props: { label: string }) {
  return (
    <span class="otk-divider-label">
      <span class="otk-control-label" title={props.label}>{props.label}</span>
      <span class="otk-divider-rule" aria-hidden="true" />
    </span>
  );
}
