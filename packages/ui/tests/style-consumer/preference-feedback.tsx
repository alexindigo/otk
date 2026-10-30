// SPDX-License-Identifier: LGPL-3.0-only
import ThemePicker from "../../components/ThemePicker.tsx";
import KeysHelp from "../../components/KeysHelp.tsx";
import { makeKeymap } from "../../keyboard/keys.ts";

export default function PreferenceFeedback() {
  let held: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const save = () => {
    held = Promise.withResolvers<void>();
    return held.promise;
  };
  styleTest.settlePreference = () =>
    held?.reject(new Error("private SQL /secret/path"));
  const keys = makeKeymap({
    describe: () => "Probe action",
    request: () => true,
  });
  keys.bind({ id: "probe", command: "probe", key: "Mod+p" });
  return (
    <>
      <section data-preference-surface="theme">
        <ThemePicker
          theme={styleTest.engine}
          ready
          systemLightTheme="otk-light"
          onSave={save}
          onSystemLightSave={save}
          onClose={() => {}}
        />
      </section>
      <section data-preference-surface="keys">
        <KeysHelp keymap={keys} ready onSave={save} onClose={() => {}} />
      </section>
    </>
  );
}
