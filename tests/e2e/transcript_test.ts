// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import {
  legacyMessageScene,
  legacyStaticMessages,
  visualText,
} from "../support/legacy-message-scene.ts";
import type { Capabilities } from "@otk/harness";
for (const theme of ["otk-dark", "otk-light"]) {
  test(`reading column, renderer disclosures, reply metadata, reported composer settings, retry and tab title (${theme})`, async () => {
    await legacyMessageScene(
      "contract-messages-reading",
      theme,
      async ({ b, set, capture, mutate }) => {
        await b.send("Emulation.setDeviceMetricsOverride", {
          width: 2000,
          height: 1100,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await b.poll("!!document.querySelector('.otk-user-bubble')");
        await b.poll(
          "!!document.querySelector('[data-message=step-1] .otk-text p')",
        );
        const geometry = await b.evaluate<
          {
            prose: number;
            code: number;
            left: number;
            codeLeft: number;
            font: string;
            size: string;
            line: string;
          }
        >("(()=>{const p=document.querySelector('[data-message=step-1] .otk-text p'),c=document.querySelector('[data-message=step-1] .otk-code'),a=p.getBoundingClientRect(),z=c.getBoundingClientRect(),s=getComputedStyle(p);return{prose:a.width,code:z.width,left:a.left,codeLeft:z.left,font:s.fontFamily,size:s.fontSize,line:s.lineHeight}})()");
        assert(
          geometry.prose <= 736 &&
            Math.abs(geometry.code - geometry.prose) < .5 &&
            Math.abs(geometry.left - geometry.codeLeft) < .5,
        );
        assert(geometry.font.includes("IBM Plex Sans"));
        assertEquals([geometry.size, geometry.line], ["14px", "24px"]);
        for (
          const current of [
            ...new Set([theme, "otk-dark", "otk-light", "otk-light-stone"]),
          ]
        ) {
          await set("theme", current);
          await b.poll(
            `document.documentElement.dataset.otkTheme==='${current}'`,
          );
          const layout = await b.evaluate<
            {
              lane: DOMRect;
              scroll: DOMRect;
              bubble: DOMRect;
              composer: DOMRect;
              border: string;
              radius: string;
              font: string;
              hints: boolean;
            }
          >("(()=>{const lane=document.querySelector('.otk-message-flow'),scroll=document.querySelector('.otk-messages'),bubble=document.querySelector('.otk-user-bubble'),composer=document.querySelector('.otk-composer'),s=getComputedStyle(composer);return{lane:lane.getBoundingClientRect().toJSON(),scroll:scroll.getBoundingClientRect().toJSON(),bubble:bubble.getBoundingClientRect().toJSON(),composer:composer.getBoundingClientRect().toJSON(),border:s.borderTopWidth,radius:s.borderRadius,font:getComputedStyle(document.querySelector('.otk-message-footer')).fontFamily,hints:/Enter to send|Shift\\+Enter for newline|1 \\/ 2 \\/ 3|j\\/k select/.test(document.querySelector('.otk-session-view').innerText)}})()");
          assertEquals(
            layout.lane.width,
            await b.evaluate(
              "(()=>{const s=document.querySelector('.otk-messages'),c=getComputedStyle(s);return Math.min(736,s.clientWidth-parseFloat(c.paddingLeft)-parseFloat(c.paddingRight))})()",
            ),
          );
          assert(
            Math.abs(
              layout.lane.left + layout.lane.right - layout.scroll.left -
                layout.scroll.right,
            ) < 1,
          );
          assert(
            Math.abs(layout.lane.left - layout.composer.left) < .5 &&
              Math.abs(layout.lane.right - layout.composer.right) < .5,
          );
          assert(
            layout.bubble.width <= layout.lane.width * .8 + .5 &&
              Math.abs(layout.bubble.right - layout.lane.right) < .5,
          );
          assertEquals([layout.border, layout.radius], ["1px", "20px"]);
          assert(layout.font.includes("IBM Plex Sans"));
          assertEquals(layout.hints, false);
          assertEquals(
            await b.evaluate(
              "document.querySelectorAll('.otk-role-label').length",
            ),
            0,
          );
          assertEquals(
            await b.evaluate(
              "getComputedStyle(document.querySelector('.otk-work-fold .otk-divider-label')).font",
            ),
            await b.evaluate(
              "getComputedStyle(document.querySelector('.otk-work-fold')).font",
            ),
          );
          const rule = await b.evaluate<
            { width: string; style: string; ratio: number }
          >("(()=>{const e=document.querySelector('.otk-work-fold .otk-divider-rule'),s=getComputedStyle(e),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const c=canvas.getContext('2d'),rgb=color=>{c.clearRect(0,0,1,1);c.fillStyle=getComputedStyle(document.documentElement).backgroundColor;c.fillRect(0,0,1,1);c.fillStyle=color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3)},bg=rgb('transparent'),distance=a=>a.reduce((n,v,i)=>n+Math.abs(v-bg[i]),0);return {width:s.borderTopWidth,style:s.borderTopStyle,ratio:distance(rgb(s.borderTopColor))/distance(rgb(s.color))}})()");
          assertEquals([rule.width, rule.style], ["1px", "solid"]);
          assert(rule.ratio > 0 && rule.ratio < .2);
          await capture(current + "-reading");
        }
        await set("theme", theme);
        for (const width of [1280, 1600, 2000]) {
          await b.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 1100,
            deviceScaleFactor: 1,
            mobile: false,
          });
          await b.poll(
            "(()=>{const s=document.querySelector('.otk-messages'),c=getComputedStyle(s),lane=document.querySelector('.otk-message-flow').getBoundingClientRect(),composer=document.querySelector('.otk-composer').getBoundingClientRect();return Math.abs(lane.width-Math.min(736,s.clientWidth-parseFloat(c.paddingLeft)-parseFloat(c.paddingRight)))<.5&&Math.abs(lane.width-composer.width)<.5&&Math.abs(lane.left-composer.left)<.5})()",
          );
          await capture(`reading-${width}`);
        }
        await mutate("fail");
        await b.poll(
          "document.querySelector('.otk-retry-banner strong')?.textContent==='Retrying · attempt 2'",
        );
        await capture("reading-retry");
        await mutate("succeed");
      },
      "tstv1-otk",
    );
  });
  test(`composer takeovers retain a browser draft through permissions, questions and session switches while actions reach stock backend in ${theme}`, async () => {
    for (const kind of ["permission", "question"] as const) {
      const capabilities: Capabilities = {
        prompt: {
          prompt: () => Promise.resolve(),
          abort: () => Promise.resolve(),
        },
      };
      if (kind === "permission") {
        capabilities.permissions = {
          listPermissions: () =>
            Promise.resolve([{
              id: "permission",
              sessionID: "tstv1-core",
              kind: "bash",
              title: "Permission outcome",
              patterns: ["printf takeover-bytes"],
              alwaysPatterns: [],
              detail: { kind: "bash", command: "printf takeover-bytes" },
              time: 1,
            }]),
          replyPermission: () => Promise.resolve(),
        };
      } else {capabilities.questions = {
          listQuestions: () =>
            Promise.resolve([{
              id: "question",
              sessionID: "tstv1-core",
              questions: [{
                header: "Next step",
                text: "Which path?",
                options: [{
                  label: "Continue",
                  description: "Use the selected path",
                }],
                multiple: false,
                custom: true,
              }],
            }]),
          answerQuestion: () => Promise.resolve(),
        };}
      await legacyStaticMessages(
        theme,
        () => [{
          id: "prompt",
          sessionID: "tstv1-core",
          role: "user",
          time: { created: 1 },
          parts: [visualText("text", "Run a separate backend turn")],
        }],
        async ({ b, capture }) => {
          await b.poll(
            `!!document.querySelector('.otk-${kind}-dock')&&document.querySelector('.otk-composer').dataset.takeover==='true'`,
          );
          assertEquals(
            await b.evaluate(
              `getComputedStyle(document.querySelector('.otk-${kind}-dock .otk-surface')).borderTopWidth`,
            ),
            "1px",
          );
          assertEquals(
            await b.evaluate(
              "!!document.querySelector('.otk-prompt').closest('[hidden]')",
            ),
            true,
          );
          await capture(kind + "-takeover");
        },
        { capabilities },
      );
    }
  });
}
