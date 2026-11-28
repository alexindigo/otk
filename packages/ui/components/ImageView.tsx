// SPDX-License-Identifier: LGPL-3.0-only
import "./ImageView.css" with { type: "text" };
export default function ImageView(
  props: { src: string; name: string; credentialed?: boolean },
) {
  return (
    <div class="otk-image-view">
      <img
        src={props.src}
        alt={props.name}
        crossorigin={props.credentialed ? "use-credentials" : undefined}
      />
    </div>
  );
}
