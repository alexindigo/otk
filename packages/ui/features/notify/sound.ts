// SPDX-License-Identifier: LGPL-3.0-only
import type { Note, NotificationHub } from "@otk/client";
/** Audio is unlocked by a real gesture, never queued for a later surprise. */
export function registerSoundChannel(
  hub: NotificationHub,
): { start(): () => void; stop(): void } {
  let context: AudioContext | undefined, stopped = false;
  const voices = new Map<string, Set<OscillatorNode>>();
  const retract = (id: string) => {
    const nodes = voices.get(id);
    voices.delete(id);
    for (const node of nodes ?? []) {
      node.stop();
      node.disconnect();
    }
  };
  const release = hub.registerChannel({
    id: "sound",
    available: () => !stopped && context?.state === "running",
    retract,
    deliver(note: Note) {
      if (
        !context || context.state !== "running" || note.kind === "info"
      ) return;
      const frequencies = note.kind === "done" ? [660, 880] : [880, 660, 880];
      const nodes = new Set<OscillatorNode>();
      voices.set(note.id, nodes);
      frequencies.forEach((frequency, i) => {
        const oscillator = context!.createOscillator(),
          gain = context!.createGain();
        const time = context!.currentTime + i * .12;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, time);
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(.08, time + .01);
        gain.gain.linearRampToValueAtTime(0, time + .09);
        oscillator.connect(gain);
        gain.connect(context!.destination);
        nodes.add(oscillator);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
          nodes.delete(oscillator);
          if (!nodes.size && voices.get(note.id) === nodes) {
            voices.delete(note.id);
          }
        };
        oscillator.start(time);
        oscillator.stop(time + .1);
      });
    },
  });
  let detach = () => {};
  return {
    start() {
      const unlock = (event: Event) => {
        if (
          !event.isTrusted || stopped || typeof AudioContext === "undefined"
        ) return;
        context ??= new AudioContext();
        void context.resume().then(() => {
          if (!stopped && context?.state === "running") detach();
        }, () => {});
      };
      document.addEventListener("pointerdown", unlock);
      document.addEventListener("keydown", unlock);
      detach = () => {
        document.removeEventListener("pointerdown", unlock);
        document.removeEventListener("keydown", unlock);
      };
      return detach;
    },
    stop() {
      stopped = true;
      detach();
      release();
      if (context) void context.close();
    },
  };
}
