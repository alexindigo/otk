// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback, FeedbackOwner } from "@otk/client";
import { createEffect, createSignal } from "solid-js";

/** Borrow a replaceable owner's state; cleanup releases presentation only. */
export function bindFeedback(
  owner: () => FeedbackOwner | undefined,
): () => Feedback | undefined {
  const [current, setCurrent] = createSignal<Feedback>();
  createEffect(owner, (value) => {
    const update = () => setCurrent(value?.current());
    update();
    return value?.subscribe(update);
  });
  return current;
}
