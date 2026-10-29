// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled, Show } from "solid-js";
import { render } from "@solidjs/web";
import { CommandHub } from "@otk/client";
import { CommandProvider, createKeyboard, useCommandPorts } from "@otk/ui";

const hubs = [new CommandHub(), new CommandHub()];
const keyboards = hubs.map((commands) => createKeyboard(commands, () => {}));
hubs.forEach((hub, index) =>
  hub.register({
    id: "probe.identity",
    title: "Identity",
    category: "Probe",
    run: () => index,
  })
);
let constructions = 0;
const [mounts, setMounts] = createSignal(0),
  [releases, setReleases] = createSignal(0);
const [selected, setSelected] = createSignal(0),
  [shown, setShown] = createSignal(true);
function Consumer() {
  const construction = ++constructions;
  const ports = useCommandPorts();
  const [copied, setCopied] = createSignal("");
  onSettled(() => {
    setMounts((value) => value + 1);
    return () => setReleases((value) => value + 1);
  });
  return (
    <section id="consumer" data-construction={construction}>
      <output id="port-keys">{Object.keys(ports).sort().join(",")}</output>
      <output id="identity">
        {String(ports.commands === hubs[selected()])}
      </output>
      <output id="keyboard">
        {String(ports.keyboard === keyboards[selected()])}
      </output>
      <button
        type="button"
        id="copy-ports"
        onClick={() => {
          const copy = { ...ports };
          void copy.commands.run<number>("probe.identity").then((identity) =>
            setCopied(String(identity))
          );
        }}
      >
        Copy and use ports
      </button>
      <output id="copied">{copied()}</output>
    </section>
  );
}
render(() => (
  <>
    <button type="button" id="replace-ports" onClick={() => setSelected(1)}>
      Replace ports
    </button>
    <button
      type="button"
      id="toggle-consumer"
      onClick={() => setShown((value) => !value)}
    >
      Toggle consumer
    </button>
    <output id="mounts">{mounts()}</output>
    <output id="releases">{releases()}</output>
    <CommandProvider
      commands={hubs[selected()]}
      keyboard={keyboards[selected()]}
    >
      <Show when={shown()}>
        <Consumer />
      </Show>
    </CommandProvider>
  </>
), document.getElementById("app")!);
