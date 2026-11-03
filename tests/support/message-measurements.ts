// SPDX-License-Identifier: LGPL-3.0-only

/** Test-only receipt/paint observation. No product debug port or body mirror. */
export async function measureMessagePaint(
  browser: {
    send(
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: { source: string },
    ): Promise<unknown>;
  },
  sessionID: string,
  origin: string,
) {
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(()=>{
      const target=${
      JSON.stringify(sessionID)
    },Native=WebSocket,NativeWorker=Worker;
      const probe=globalThis.messageMeasurements={requests:[],pages:[],snapshots:[],bootstraps:[],invalidations:[],paints:[],longTasks:[],highlightWork:[],intent:null};
      globalThis.Worker=class extends NativeWorker{
        constructor(...args){super(...args);const post=this.postMessage.bind(this);this.postMessage=(value,...rest)=>{probe.highlightWork.push({at:performance.now(),kind:value?.t??value?.type??'message'});return post(value,...rest)}}
      };
      new PerformanceObserver(list=>{for(const e of list.getEntries())probe.longTasks.push({at:e.startTime,ms:e.duration})}).observe({type:'longtask',buffered:true});
      globalThis.WebSocket=class extends Native{
        constructor(...args){super(...args);this.addEventListener('message',event=>{
          const f=JSON.parse(event.data),at=performance.now();
          if(f.t==='index.snapshot')probe.snapshots.push({at,count:f.entries.length,ready:f.entries.every(e=>e.digest.state==='ready')});
          if(f.t==='bootstrap.complete')probe.bootstraps.push({at});
          if(f.t==='transcript.invalidated')probe.invalidations.push({at,version:f.version,sessionID:f.sessionID});
          if(f.t==='request.result'){
            const request=probe.requests.find(r=>r.id===f.ref.key);
            if(request){const page={at,request,ok:f.outcome.ok,ids:f.outcome.result?.items?.map(m=>m.id),older:f.outcome.result?.older,error:f.outcome.error};probe.pages.push(page);performance.mark('otk-page-received');setTimeout(()=>{page.turnSettled=performance.now();performance.mark('otk-page-turn-settled')},0)}
          }
        })}
        send(data){const f=JSON.parse(data);if(f.t==='request'&&f.method==='session.messages'&&f.params.sessionID===target){probe.requests.push({id:f.ref.key,at:performance.now(),before:f.params.before});performance.mark('otk-page-request')}return super.send(data)}
      };
      document.addEventListener('click',event=>{
        if(event.isTrusted&&event.target?.closest?.(${JSON.stringify(origin)})){
          probe.paints=[];probe.intent=performance.now();performance.mark('otk-open-intent');requestAnimationFrame(sample);
        }
      },true);
      const sample=()=>{
        if(probe.intent!==null&&!probe.paints.length){
          const flow=document.querySelector('.otk-message-flow'),pane=document.querySelector('.otk-messages');
          if(flow&&pane&&location.hash.endsWith('/'+target)){
            const v=pane.getBoundingClientRect(),visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>v.top&&r.top<v.bottom};
            const source=[...flow.querySelectorAll('.otk-text p')].find(e=>e.textContent==='Scale fixture 0/1524/2'&&visible(e));
            const footer=[...flow.querySelectorAll('.otk-message-footer')].find(e=>visible(e)&&e.querySelector('.otk-message-agent')?.textContent.toLowerCase()==='build'&&e.textContent.includes('fake/scripted')&&e.querySelector('.otk-turn-time')?.textContent&&!e.textContent.includes('streaming'));
            if(source&&footer){requestAnimationFrame(()=>{if(!source.isConnected||!footer.isConnected||!visible(source)||!visible(footer)){requestAnimationFrame(sample);return}probe.paints.push({at:performance.now(),ms:performance.now()-probe.intent,count:Number(flow.dataset.messageCount),source:source.textContent,footer:footer.textContent,sourceBox:source.getBoundingClientRect().toJSON(),footerBox:footer.getBoundingClientRect().toJSON(),viewport:v.toJSON()})});return}
          }
        }
        requestAnimationFrame(sample);
      };
    })()`,
  });
}

export interface MessagePaintEvidence {
  requests: { id: string; at: number; before?: string }[];
  pages: {
    at: number;
    request: { id: string; at: number; before?: string };
    ok: boolean;
    ids?: string[];
    older?: string | null;
    error?: unknown;
    turnSettled?: number;
  }[];
  snapshots: { at: number; count: number; ready: boolean }[];
  bootstraps: { at: number }[];
  invalidations: {
    at: number;
    version: { generation: number; revision: number };
    sessionID?: string;
  }[];
  paints: { at: number; ms: number; count: number; source: string }[];
  longTasks: { at: number; ms: number }[];
  highlightWork: { at: number; kind: string }[];
  intent: number;
}
