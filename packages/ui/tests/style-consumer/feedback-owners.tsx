// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, Show } from "solid-js";
import type { Feedback, FeedbackOwner } from "@otk/client";
import { bindFeedback } from "../../state/feedback.ts";
import FeedbackStatus from "../../components/FeedbackStatus.tsx";

export default function FeedbackOwners() {
  const [selected, setSelected] = createSignal(0),
    [mounted, setMounted] = createSignal(true),
    [subscriptions, setSubscriptions] = createSignal([0, 0]);
  const values: (Feedback | undefined)[] = [],
    listeners = [new Set<() => void>(), new Set<() => void>()];
  const owners: FeedbackOwner[] = listeners.map((set, index) => ({
    current: () => values[index],
    subscribe(listener) {
      set.add(listener);
      setSubscriptions(listeners.map((value) => value.size));
      return () => {
        set.delete(listener);
        setSubscriptions(listeners.map((value) => value.size));
      };
    },
    fail() {},
    clear() {},
  }));
  styleTest.feedbackOwner = setSelected;
  styleTest.mountFeedback = setMounted;
  styleTest.emitFeedback = (index, kind) => {
    values[index] = {
      kind,
      text: index === 0 ? "Original target" : "Replacement target",
    };
    listeners[index].forEach((listener) => listener());
  };
  function Bound() {
    const feedback = bindFeedback(() => owners[selected()]);
    return <FeedbackStatus feedback={feedback()} />;
  }
  return (
    <section data-owner-subscriptions={subscriptions().join(",")}>
      <Show when={mounted()}>
        <Bound />
      </Show>
    </section>
  );
}
