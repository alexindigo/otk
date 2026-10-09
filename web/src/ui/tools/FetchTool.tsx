// SPDX-License-Identifier: LGPL-3.0-only
import type { FetchCall } from "../../../../protocol/content.ts";
export default function FetchTool(props: { call: FetchCall }) {
  return <div class="otk-tool-summary">WebFetch {props.call.url}</div>;
}
