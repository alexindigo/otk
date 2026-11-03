// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";

/** External observers delegate to the real Notification and Web Audio APIs. */
export async function instrumentNotifications(
  page: Page,
  failConstruction = false,
) {
  await page.addInitScript(`(() => {
    globalThis.notificationEvidence={notes:[],permissionRequests:0,audio:[],contexts:[]};
    const Native=Notification;
    globalThis.Notification=class extends Native {
      static requestPermission(...args){notificationEvidence.permissionRequests++;return Native.requestPermission(...args)}
      constructor(title,options){${
    failConstruction
      ? "throw new TypeError('External constructor unavailability');"
      : "super(title,options);"
  }
        const row={title,options,instance:this,closed:false};notificationEvidence.notes.push(row);
        const close=this.close.bind(this);this.close=()=>{row.closed=true;return close()};
      }
    };
    const Audio=AudioContext,analysers=new WeakMap();
    globalThis.AudioContext=class extends Audio {
      constructor(...args){super(...args);notificationEvidence.contexts.push({context:this,gesture:navigator.userActivation.isActive})}
      createGain(){const gain=super.createGain(),analyser=super.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=0;gain.connect(analyser);analysers.set(gain,analyser);return gain}
      createOscillator(){const oscillator=super.createOscillator(),start=oscillator.start.bind(oscillator),connect=oscillator.connect.bind(oscillator),schedule=oscillator.frequency.setValueAtTime.bind(oscillator.frequency);let frequency=0,analyser;
        oscillator.frequency.setValueAtTime=(value,time)=>{frequency=value;return schedule(value,time)};
        oscillator.connect=(target,...args)=>{analyser=analysers.get(target);return connect(target,...args)};
        oscillator.start=(time)=>{const row={frequency,state:this.state,time,peaks:[]};notificationEvidence.audio.push(row);
          const timer=setInterval(()=>{if(this.state==='closed'||this.currentTime>time+.2){clearInterval(timer);return}if(!analyser||this.currentTime<time)return;
            const bins=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(bins);let peak=0;for(let i=1;i<bins.length;i++)if(bins[i]>bins[peak])peak=i;
            if(bins[peak]>-75)row.peaks.push(peak*this.sampleRate/analyser.fftSize);
          },5);return start(time)};return oscillator;
      }
    };
  })()`);
}
export async function focusNotifications(page: Page) {
  await page.bringToFront();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp.detach();
  await expect.poll(() =>
    page.evaluate(() =>
      document.hasFocus() && document.visibilityState === "visible"
    )
  ).toBe(true);
}
export async function hideNotifications(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  const own = await cdp.send("Target.getTargetInfo");
  const cover = await cdp.send("Target.createTarget", {
    url: "about:blank",
    background: false,
    browserContextId: own.targetInfo.browserContextId,
  });
  await cdp.send("Target.activateTarget", { targetId: cover.targetId });
  try {
    await expect.poll(() =>
      page.evaluate(() => ({
        focus: document.hasFocus(),
        visibility: document.visibilityState,
      }))
    ).toEqual({ focus: false, visibility: "hidden" });
  } catch (error) {
    await cdp.send("Target.closeTarget", { targetId: cover.targetId });
    await cdp.detach();
    throw error;
  }
  return async () => {
    await cdp.send("Target.closeTarget", { targetId: cover.targetId });
    await focusNotifications(page);
    await cdp.detach();
  };
}
export async function badge(page: Page, count: number) {
  await expect.poll(() =>
    page.locator("link[rel=icon]").evaluate((icon) => {
      const svg = new DOMParser().parseFromString(
        decodeURIComponent((icon as HTMLLinkElement).href.split(",")[1]),
        "image/svg+xml",
      );
      const dot = !!svg.querySelector("circle");
      return {
        dot,
        count: dot
          ? Number(svg.querySelector("text:last-child")!.textContent)
          : 0,
      };
    })
  ).toEqual({ dot: count > 0, count });
}
export const toast = (id: string, sidecar = "local") =>
  `.otk-toast[data-note="${sidecar}/${id}"]`;
export const notes = (page: Page, expression: string) =>
  page.evaluate(
    `(()=>{const {notes,permissionRequests,audio,contexts}=notificationEvidence;return (${expression})})()`,
  );
