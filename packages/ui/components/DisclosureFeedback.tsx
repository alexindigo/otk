// SPDX-License-Identifier: LGPL-3.0-only
import { errorFeedback, failureValue, type TreeDisclosure } from "@otk/client";
import { createMemo, Show } from "solid-js";
import FeedbackStatus from "./FeedbackStatus.tsx";

export default function DisclosureFeedback(props: {
  disclosure?: TreeDisclosure;
  actionLabel: string;
  class?: string;
}): import("solid-js").Element {
  const feedback = createMemo(() => {
    const disclosure = props.disclosure;
    const cause = disclosure?.error();
    if (!disclosure || !cause) return undefined;
    return {
      ...errorFeedback(
        failureValue(cause, { actionLabel: props.actionLabel }),
      )!,
      action: { label: "Retry", run: () => disclosure.retry() },
    };
  });
  return (
    <Show when={feedback()}>
      <FeedbackStatus class={props.class} feedback={feedback()} />
    </Show>
  );
}
