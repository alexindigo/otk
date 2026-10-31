// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled, Show } from "solid-js";
import { render } from "@solidjs/web";
import { CommandHub } from "@otk/client";
import {
  browserThemeEnvironment,
  CommandProvider,
  createKeyboard,
  registerOtkThemes,
  ThemeEngine,
  ThemeRegistry,
  useCommandPorts,
} from "@otk/ui";

const themes = new ThemeRegistry();
registerOtkThemes(themes);
const theme = new ThemeEngine(
  themes,
  browserThemeEnvironment(),
  new URL(location.href).searchParams.get("theme") ?? "otk-dark",
);
theme.start();

const hubs = [new CommandHub(), new CommandHub()];
const keyboards = hubs.map((commands) => createKeyboard(commands, () => {}));
const failureOwners = hubs.map((hub) => (cause: unknown) => cause === hub);
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
      <output id="failure-owned">
        {String(ports.failureOwned === failureOwners[selected()])}
      </output>
      <button
        type="button"
        id="copy-ports"
        onClick={() => {
          const copy = { ...ports };
          if (!copy.failureOwned?.(hubs[selected()])) {
            throw new Error("Copied failure ownership port is stale");
          }
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
      failureOwned={failureOwners[selected()]}
    >
      <Show when={shown()}>
        <Consumer />
      </Show>
    </CommandProvider>
  </>
), document.getElementById("app")!);
