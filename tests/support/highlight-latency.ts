// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";

export interface HighlightSample {
  marker: string;
  firstSource: number;
  start?: number;
  end?: number;
  latency?: number;
  sourceLength?: number;
  markers?: string[];
}
export interface HighlightEvidence {
  blocks: HighlightSample[];
  revisions: HighlightSample[];
  longtasks: { start: number; duration: number }[];
  observerMs: number;
  reads: number;
}
/** Missing/delayed revisions cannot disappear from the percentile population. */
export function highlightDistribution(
  samples: HighlightSample[],
  minimum: number,
) {
  assert(
    samples.length >= minimum,
    `Need at least ${minimum} source revisions`,
  );
  assert(
    samples.every((sample) =>
      sample.start !== undefined && sample.end !== undefined &&
      sample.latency !== undefined && Number.isFinite(sample.latency)
    ),
    "Every source revision needs its own visible styled-frame observation",
  );
  const sorted = samples.map((sample) => sample.latency!).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1],
    max: sorted.at(-1)!,
  };
}
export function assertHighlightBudget(
  samples: HighlightSample[],
  minimum: number,
) {
  const distribution = highlightDistribution(samples, minimum);
  assert(
    distribution.p95 <= 200,
    `STOP: shiki p95 ${distribution.p95} ms exceeds 200 ms`,
  );
  return distribution;
}

// One lifecycle and one range/style predicate for both acknowledged and passive
// measurements. The observer never scrolls, submits, releases or schedules input.
export const highlightObservers = `(() => {
  globalThis.highlightEvidence = { blocks: [], revisions: [], longtasks: [], observerMs: 0, reads: 0 };
  const tasks = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) highlightEvidence.longtasks.push({start:entry.startTime,duration:entry.duration,attribution:entry.attribution.map(a=>({name:a.name,containerType:a.containerType,containerSrc:a.containerSrc}))});
  });
  tasks.observe({type:'longtask'});
  globalThis.highlightCancel=()=>{};
  const watch=(selector, marker, passive)=>{
    highlightCancel();
    const root=document.querySelector('.otk-messages'), pending=new Set();
    let frame, done=false, previous='', lastIndex=-1;
    if(!passive)pending.add({marker});
    const inspect=(rendered=false)=>{
      if(done)return;
      const began=performance.now();highlightEvidence.reads++;
      const code=root.querySelector(selector);
      if(code) {
        const source=code.textContent;
        if(passive && source!==previous) {
          previous=source;
          const matches=[...source.matchAll(new RegExp('\\\\b'+marker+'(\\\\d+)\\\\b','g'))];
          const added=matches.filter(match=>Number(match[1])>lastIndex);
          if(added.length) {
            const latest=added.at(-1);
            lastIndex=Number(latest[1]);
            const sample={marker:latest[0],markers:added.map(match=>match[0]),firstSource:performance.now(),sourceLength:source.length};
            pending.add(sample);highlightEvidence.revisions.push(sample);
          }
        }
        const viewport=root.getBoundingClientRect(), locations=new Map();
        const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
        let node;
        while(node=walker.nextNode()) {
          for(const sample of pending) {
            const offset=node.textContent.indexOf(sample.marker);
            // Identifiers such as streamed1 and streamed10 must never alias.
            if(offset>=0 && !/[\\w$]/.test(node.textContent[offset+sample.marker.length]||''))locations.set(sample,{node,offset});
          }
        }
        for(const sample of pending) {
          const location=locations.get(sample);if(!location)continue;
          sample.firstSource??=performance.now();
          const {node,offset}=location;
          const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+sample.marker.length);
          const rect=range.getBoundingClientRect();
          if(rect.top<viewport.top||rect.bottom>viewport.bottom||!rect.width)continue;
          sample.start??=performance.now();
          const token=node.parentElement.closest('.otk-token');
          if(rendered && token?.style.color && getComputedStyle(token).color!=='rgba(0, 0, 0, 0)') {
            sample.end=performance.now();sample.latency=sample.end-sample.start;
            pending.delete(sample);
            if(!passive) {highlightEvidence.blocks.push(sample);done=true;observer.disconnect()}
          }
        }
      }
      highlightEvidence.observerMs+=performance.now()-began;
      if(!done)frame=requestAnimationFrame(()=>inspect(true));
    };
    const observer=new MutationObserver(()=>{cancelAnimationFrame(frame);inspect()});
    observer.observe(root,{subtree:true,childList:true,characterData:true});
    frame=requestAnimationFrame(()=>inspect(true));
    globalThis.highlightCancel=()=>{done=true;cancelAnimationFrame(frame);observer.disconnect()};
  };
  globalThis.highlightMeasure=(selector,marker)=>watch(selector,marker,false);
  globalThis.highlightStream=(selector,prefix)=>watch(selector,prefix,true);
  globalThis.highlightStop=()=>{highlightCancel();tasks.disconnect()};
})()\n//# sourceURL=otk-highlight-observer.js`;
