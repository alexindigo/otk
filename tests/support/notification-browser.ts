// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { Cdp } from "./cdp.ts";
/** Entirely external observation, installed before application modules load. */
export async function instrumentNotifications(
  browser: Cdp,
  failConstruction = false,
) {
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
    globalThis.notificationEvidence = { notes:[], permissionRequests:0, audio:[], contexts:[] };
    const Native = Notification;
    globalThis.Notification = class extends Native {
      static requestPermission(...args) { notificationEvidence.permissionRequests++; return Native.requestPermission(...args); }
      constructor(title, options) {
        ${
      failConstruction
        ? "throw new TypeError('External constructor unavailability');"
        : "super(title, options);"
    }
        const row = { title, options, instance:this, closed:false };
        notificationEvidence.notes.push(row);
        const close = this.close.bind(this); this.close = () => { row.closed=true; return close(); };
      }
    };
    const Audio = AudioContext, analysers = new WeakMap();
    globalThis.AudioContext = class extends Audio {
      constructor(...args) { super(...args); notificationEvidence.contexts.push({ context:this, gesture:navigator.userActivation.isActive }); }
      createGain() {
        const gain=super.createGain(), analyser=super.createAnalyser();
        analyser.fftSize=2048; analyser.smoothingTimeConstant=0;
        gain.connect(analyser); analysers.set(gain,analyser); return gain;
      }
      createOscillator() {
        const oscillator=super.createOscillator(), start=oscillator.start.bind(oscillator), connect=oscillator.connect.bind(oscillator);
        const schedule=oscillator.frequency.setValueAtTime.bind(oscillator.frequency);
        let frequency=0, analyser;
        oscillator.frequency.setValueAtTime=(value,time)=> { frequency=value; return schedule(value,time); };
        oscillator.connect=(target,...args)=> { analyser=analysers.get(target); return connect(target,...args); };
        oscillator.start=(time)=> {
          const row={ frequency, state:this.state, time, peaks:[] }; notificationEvidence.audio.push(row);
          const timer=setInterval(()=> {
            if(this.state==='closed' || this.currentTime>time+.2) {clearInterval(timer);return;}
            if(!analyser || this.currentTime<time) return;
            const bins=new Float32Array(analyser.frequencyBinCount); analyser.getFloatFrequencyData(bins);
            let peak=0; for(let i=1;i<bins.length;i++) if(bins[i]>bins[peak]) peak=i;
            if(bins[peak]>-75) row.peaks.push(peak*this.sampleRate/analyser.fftSize);
          },5);
          return start(time);
        };
        return oscillator;
      }
    };
  })()`,
  });
}
export async function focusNotifications(browser: Cdp) {
  await browser.send("Page.bringToFront");
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await browser.poll(
    "document.hasFocus() && document.visibilityState==='visible'",
  );
}
export async function hideNotifications(
  browser: Cdp,
): Promise<() => Promise<void>> {
  await browser.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  const own = await browser.send("Target.getTargetInfo");
  const { targetId } = await browser.send("Target.createTarget", {
    url: "about:blank",
    background: false,
  });
  await browser.send("Target.activateTarget", { targetId });
  await browser.poll(
    "!document.hasFocus() && document.visibilityState==='hidden'",
  );
  assertEquals(await browser.evaluate("document.visibilityState"), "hidden");
  return async () => {
    await browser.send("Target.closeTarget", { targetId });
    await browser.send("Target.activateTarget", {
      targetId: (own.targetInfo as { targetId: string }).targetId,
    });
    await focusNotifications(browser);
  };
}
export async function notificationSettings(browser: Cdp) {
  await browser.poll("!!document.querySelector('.otk-settings-entry')");
  await browser.click(".otk-settings-entry");
  await browser.poll("!!document.querySelector('.otk-notification-settings')");
}
export async function closeNotificationSettings(browser: Cdp) {
  await browser.click(".otk-settings .otk-view-header button");
  await browser.poll("!document.querySelector('.otk-settings')");
}
