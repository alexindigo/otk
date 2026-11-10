// SPDX-License-Identifier: LGPL-3.0-only
import { nativeKind } from "./native.ts";
import {
  type ScaleManifest,
  type ScaleVariant,
  SessionScale,
} from "./session-scale.ts";
import { V2SessionScale } from "./v2-session-scale.ts";
import type { FakeLlm } from "./fake-llm.ts";
import type { MessageScaleOptions } from "./message-scale-cases.ts";
import { destination } from "./snapshots.ts";
import { useNativeDiscovery } from "./native-testing.ts";
export async function createScale(
  root: string,
  parent: string,
  fake: FakeLlm,
  options: MessageScaleOptions = {},
) {
  if (nativeKind === "opencode-v1") {
    return await SessionScale.create(root, parent, fake, options);
  }
  await destination(root, parent);
  const variant: ScaleVariant = options.files
    ? "remaining-files"
    : options.payload
    ? "messages-payload"
    : options.messages
    ? "messages"
    : "sessions";
  return await V2SessionScale.materialize(
    await V2SessionScale.generate(variant, fake),
    fake,
  );
}
export async function scaleDiscovery(
  fixture: SessionScale | V2SessionScale,
  url = fixture.url,
) {
  if (!(fixture instanceof V2SessionScale)) return;
  await useNativeDiscovery(fixture.native, url);
}
export async function promptScale(
  fixture: SessionScale | V2SessionScale,
  session: ScaleManifest["sessions"][number],
  text: string,
) {
  if (fixture instanceof V2SessionScale) {
    await fixture.native.prompt(session.id, text);
    await fixture.native.api.experimental.session.wait({
      sessionID: session.nativeID,
    });
  } else {
    await fixture.request(`/session/${session.nativeID}/message`, {
      method: "POST",
      directory: session.directory,
      body: {
        model: { providerID: "fake", modelID: "scripted" },
        parts: [{ type: "text", text }],
      },
    });
  }
}
