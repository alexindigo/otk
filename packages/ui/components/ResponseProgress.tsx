// SPDX-License-Identifier: LGPL-3.0-only
import "./ResponseProgress.css" with { type: "text" };

/** In-flow progress belongs to the unfinished response, not the viewport. */
export default function ResponseProgress() {
  return (
    <div
      class="otk-response-progress"
      role="status"
      aria-label="Response in progress"
    >
      <div class="otk-response-glimmer" aria-hidden="true" />
      <span class="otk-response-progress-text" aria-hidden="true">
        response in progress
      </span>
    </div>
  );
}
