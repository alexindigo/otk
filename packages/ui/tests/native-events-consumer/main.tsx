// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled, Show } from "solid-js";
import { render } from "@solidjs/web";
import ContentTextarea from "../../components/ContentTextarea.tsx";
import { nativeAttributes } from "../../components/native-attributes.ts";
import "./style.css" with { type: "text" };

const [shown, setShown] = createSignal(true),
  [events, setEvents] = createSignal(0);
const [getter, setGetter] = createSignal(false),
  [target, setTarget] = createSignal("");
const [clicks, setClicks] = createSignal(0),
  [receiver, setReceiver] = createSignal("");
const [forwarded, setForwarded] = createSignal<Record<string, unknown>>({
  id: "forwarded-button",
  "aria-label": "Original attributes",
  onClick: {
    once: true,
    capture: true,
    handleEvent() {
      setClicks((value) => value + 1);
    },
  },
});
function ForwardedButton() {
  const native = nativeAttributes(forwarded);
  return (
    <button type="button" {...native.attributes} ref={native.ref}>
      Forwarded action
    </button>
  );
}
function Editor() {
  const [value, setValue] = createSignal("");
  onSettled(() => {
    const request = new AbortController();
    void fetch("/source", { signal: request.signal }).then((response) =>
      response.text()
    ).then((text) => {
      if (!request.signal.aborted) setValue(text);
    }).catch((error) => {
      if (!request.signal.aborted) throw error;
    });
    return () => request.abort();
  });
  return (
    <ContentTextarea
      id="event-editor"
      aria-label="Event editor"
      value={value()}
      onKeyDown={(event) => {
        setGetter(
          !!Object.getOwnPropertyDescriptor(event, "currentTarget")?.get,
        );
        setTarget(event.currentTarget.id);
        if (value().length) setEvents((count) => count + 1);
      }}
    />
  );
}
render(() => (
  <>
    <button type="button" id="retire-editor" onClick={() => setShown(false)}>
      Retire editor
    </button>
    <output id="event-count">{events()}</output>
    <output id="event-getter">{String(getter())}</output>
    <output id="event-target">{target()}</output>
    <button
      type="button"
      id="replace-handler"
      onClick={() =>
        setForwarded({
          id: "tuple-button",
          "aria-label": "Replacement attributes",
          onClick: [function (this: HTMLElement, amount: number, event: Event) {
            setReceiver(
              this.id + ":" + (event.currentTarget as HTMLElement).id,
            );
            setClicks((value) => value + amount);
          }, 2],
        })}
    >
      Replace handler
    </button>
    <button
      type="button"
      id="remove-handler"
      onClick={() =>
        setForwarded({ id: "tuple-button", "aria-label": "No handler" })}
    >
      Remove handler
    </button>
    <ForwardedButton />
    <output id="clicks">{clicks()}</output>
    <output id="receiver">{receiver()}</output>
    <Show when={shown()}>
      <Editor />
    </Show>
  </>
), document.getElementById("app")!);
