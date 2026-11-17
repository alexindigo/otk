// SPDX-License-Identifier: LGPL-3.0-only
// UI rule 3 exempts only the declared primary action, never a secondary control.
import { expect, test } from "../../fixtures/evidence.ts";
import { uiRuleFailures } from "../../pages/ui-rules.ts";
import {
  expectRuleThree,
  primaryViolations,
  readPrimary,
} from "../../pages/primary-action.ts";

const send = (attributes = 'aria-description="Write a message"') =>
  `<button type="submit" data-primary-action="true" disabled ${attributes}>Send</button>`;
const composer = (body: string) =>
  `<div class="otk-composer"><div class="otk-prompt">${body}</div></div>`;

test(
  "visual.primary-action-rule-three-exemption-is-exact",
  { tag: ["@visual", "@composer", "@contracts"] },
  async ({ page }, info) => {
    const rule3 = async (html: string) => {
      await page.setContent(html);
      return (await uiRuleFailures(page, info, "primary-rule"))
        .filter((failure) => failure.rule === 3);
    };
    // A disabled primary with its reason is the decided main-CTA contract.
    expect(await rule3(composer(send()))).toEqual([]);
    await expectRuleThree(page);
    // A disabled secondary control still fails, beside a valid primary.
    expect(
      await rule3(composer(send() + "<button disabled>Attach</button>")),
    ).toEqual([ // The composer and its prompt are both audited roots.
      { region: "composer", rule: 3, count: 1 },
      { region: "composer", rule: 3, count: 1 },
    ]);
    await expect(expectRuleThree(page)).rejects.toThrow();
    // A second marked element in the same host fails.
    expect(await rule3(composer(send() + send()))).toHaveLength(2);
    await expect(expectRuleThree(page)).rejects.toThrow();
    // The exemption needs an accessible reason and a rendered control.
    expect(await rule3(composer(send("")))).toEqual([
      {
        region: "primary",
        rule: 3,
        value: { primary: "disabled without reason" },
      },
    ]);
    expect(
      await rule3(composer(send('aria-description="Sending" hidden'))),
    ).toEqual([
      { region: "primary", rule: 3, value: { primary: "disabled and hidden" } },
    ]);
    // A takeover hides the whole composer; only the takeover's primary counts.
    const takeover = (body: string) =>
      `<div class="otk-composer" hidden>${composer(send())}</div>` +
      `<section class="otk-takeover">${body}</section>`;
    const allow = send('aria-description="Sending response"');
    expect(await rule3(takeover(allow))).toEqual([]);
    await expectRuleThree(page);
    // One visible primary per visible surface still holds in the takeover.
    expect(await rule3(takeover(allow + allow))).toHaveLength(2);
    // Every presented host owns one primary, including an empty host root.
    for (const html of [composer(""), takeover("")]) {
      expect.soft(await rule3(html)).toEqual([
        { region: "primary", rule: 3, value: { primary: "0 in one host" } },
      ]);
      expect.soft(await expectRuleThree(page).then(() => false, () => true))
        .toBe(true);
      const host = page.locator(
        html === composer("") ? ".otk-prompt" : ".otk-takeover",
      );
      expect.soft(primaryViolations(await readPrimary(host))).toEqual([{
        primary: "0 in one host",
      }]);
    }
    // Availability never permits a primary to disappear; reasons apply only
    // while disabled. Check the enabled-hidden branch independently.
    expect.soft(
      await rule3(composer("<button data-primary-action hidden>Send</button>")),
    ).toEqual([
      { region: "primary", rule: 3, value: { primary: "hidden" } },
    ]);
    expect.soft(
      await rule3(composer("<button data-primary-action>Send</button>")),
    ).toEqual([]);
  },
);
