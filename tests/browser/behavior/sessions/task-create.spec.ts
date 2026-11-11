// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "sessions-tasks" });
test("sessions.task-create-receipt-before-publication", {
  tag: ["@sessions", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Task creation",
  });
  await state.product("prefs.set", { key: "theme", value: "otk-dark" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(`(()=>{
    const Native=WebSocket;globalThis.taskPublication={hold:false,queue:[],key:null,receipt:null,release(){this.hold=false;for(const deliver of this.queue.splice(0))deliver()}};
    globalThis.WebSocket=class extends Native{
      set onmessage(listener){super.onmessage=listener?event=>{const frame=JSON.parse(event.data);if(frame.t==='request.result'&&frame.ref.key===taskPublication.key)taskPublication.receipt=frame.outcome;if(taskPublication.hold&&frame.t==='inbox.patch'){taskPublication.queue.push(()=>listener.call(this,event));return}listener.call(this,event)}:null}
      get onmessage(){return super.onmessage}
      send(data){const frame=JSON.parse(data);if(frame.t==='request'&&frame.method==='tasks.create')taskPublication.key=frame.ref.key;super.send(data)}
    };
  })()`);
  await openSession(state, page, session.id);
  await page.locator(".otk-task-new").click();
  await page.locator("input[name=taskName]").fill("Publication-safe task");
  await page.evaluate("taskPublication.hold=true");
  await page.locator('dialog button[type="submit"]').click();
  await page.waitForFunction("taskPublication.receipt?.ok===true");
  await page.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  await expect(page.locator("dialog [role=alert]")).toHaveCount(0);
  await expect(page.locator("dialog")).toHaveCount(1);
  await page.evaluate("taskPublication.release()");
  await expect(page.locator("dialog")).toHaveCount(0);
  const task =
    (await state.product("tasks.list", { directory: state.directory })).find((
      task,
    ) => task.name === "Publication-safe task")!;
  await expect(page.locator(`[data-tab="${task.id}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const path = info.outputPath("task-create-after.png");
  await page.screenshot({ path, fullPage: true });
  await info.attach("task-create-after", { path, contentType: "image/png" });
});
