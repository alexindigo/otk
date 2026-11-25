// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page } from "@playwright/test";

/** Observe the real Notification API; OS permission cases never patch audio. */
export async function instrumentNotifications(
  page: Page,
  failConstruction = false,
) {
  await page.addInitScript(`(() => {
    globalThis.notificationEvidence={notes:[],permissionRequests:0};
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
  })()`);
}

/** Install the render-thread observer only on the page proving sound. */
export async function instrumentNotificationAudio(page: Page) {
  await page.addInitScript(`(() => {
    globalThis.notificationAudioEvidence={audio:[],contexts:[]};
    const Audio=AudioContext,captures=new WeakMap(),fftSize=2048;
    // Keep one FFT window of the real gain output on the render thread. A busy
    // page can miss an entire tone if it polls the live analyser from JS.
    const worklet = \`
      registerProcessor('notification-capture', class extends AudioWorkletProcessor {
        samples = new Float32Array(\${fftSize});
        used = 0;
        process([[channel]]) {
          if (this.used === this.samples.length) return false;
          for (const sample of channel ?? []) {
            if (!this.used && sample === 0) continue;
            this.samples[this.used++] = sample;
            if (this.used === this.samples.length) {
              this.port.postMessage(this.samples);
              return false;
            }
          }
          return true;
        }
      });\`;
    async function recordPeak(samples, rate, peaks) {
      // Read the browser's native analyser after the saved window renders,
      // rather than racing the live context's clock.
      const offline = new OfflineAudioContext(1, fftSize, rate);
      const source = offline.createBufferSource();
      source.buffer = offline.createBuffer(1, fftSize, rate);
      source.buffer.copyToChannel(samples, 0);
      const analyser = offline.createAnalyser();
      analyser.fftSize = fftSize;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser).connect(offline.destination);
      source.start();
      await offline.startRendering();
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      let peak = 0;
      for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
      if (bins[peak] > -75) peaks.push(peak * rate / fftSize);
    }
    globalThis.AudioContext=class extends Audio {
      constructor(...args){
        super(...args);
        const row={context:this,gesture:navigator.userActivation.isActive,captureReady:false};
        notificationAudioEvidence.contexts.push(row);
        const url=URL.createObjectURL(new Blob([worklet],{type:'text/javascript'}));
        void this.audioWorklet.addModule(url).then(()=>{row.captureReady=true}).finally(()=>URL.revokeObjectURL(url));
      }
      createGain(){
        const gain=super.createGain(),capture=new AudioWorkletNode(this,'notification-capture',{numberOfOutputs:0});
        gain.connect(capture);
        captures.set(gain,capture);
        return gain;
      }
      createOscillator(){const oscillator=super.createOscillator(),start=oscillator.start.bind(oscillator),connect=oscillator.connect.bind(oscillator),schedule=oscillator.frequency.setValueAtTime.bind(oscillator.frequency);let frequency=0,capture;
        oscillator.frequency.setValueAtTime=(value,time)=>{frequency=value;return schedule(value,time)};
        oscillator.connect=(target,...args)=>{capture=captures.get(target);return connect(target,...args)};
        oscillator.start=(time)=>{const row={frequency,state:this.state,time,peaks:[]};notificationAudioEvidence.audio.push(row);
          if(capture)capture.port.onmessage=({data})=>recordPeak(data,this.sampleRate,row.peaks);
          return start(time);
        };return oscillator;
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
    `(()=>{const {notes,permissionRequests}=notificationEvidence;return (${expression})})()`,
  );
export const tones = (page: Page, expression: string) =>
  page.evaluate(
    `(()=>{const {audio,contexts}=notificationAudioEvidence;return (${expression})})()`,
  );
