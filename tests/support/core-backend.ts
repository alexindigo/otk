// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl, join } from "@std/path";
import { type Capabilities, ContentReplay, type Harness } from "@otk/harness";
import { startApplication } from "../../application.ts";
import { cfg } from "./config.ts";
import { resources } from "./resources.ts";
import { fixturePage } from "./message-pages.ts";

/** Real core composition with caller-supplied optional backend capabilities. */
export async function coreBackendFixture(
  root: string,
  capabilities: Capabilities = {},
  identity = "tstv1-core",
) {
  const scope = resources();
  const settings = cfg();
  settings.auth.type = "none";
  settings.server.port = 0;
  settings.state.path = join(root, "state");
  const session = {
    id: identity,
    directory: root,
    projectID: "project",
    title: "Core-only backend",
    time: { created: 1, updated: 1 },
    archived: false,
  };
  const replay = new ContentReplay({
    ...settings.messages,
    nonce: () => crypto.randomUUID(),
    emit: (...args) => emit(...args),
  });
  const page = (messages: import("@otk/protocol").Message[], before?: string) =>
    fixturePage(identity, messages, before, session, replay.clock(identity));
  const backend: Harness = {
    core: {
      kind: "external",
      version: "1",
      start(sink) {
        sink.connection("connected");
        sink.indexReset([{
          id: session.id,
          directory: root,
          projectID: "project",
          title: session.title,
          timeCreated: 1,
          timeUpdated: 1,
          archived: false,
          status: "idle",
          attention: {
            permissions: 0,
            questions: 0,
            childPermissions: 0,
            childQuestions: 0,
          },
        }]);
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
      subscriptions() {},
      getSession: () => Promise.resolve(session),
      createSession: () => Promise.resolve(session),
      listChildren: () => Promise.resolve([]),
      listMessages: () =>
        Promise.resolve(page([{
          id: "message",
          sessionID: identity,
          role: "user",
          time: { created: 1 },
          parts: [{
            id: "text",
            kind: "text",
            synthetic: false,
            blocks: [{
              b: "paragraph",
              inline: [{ i: "text", text: "Core transcript" }],
            }],
          }],
        }])),
    },
    capabilities,
  };
  const app = await startApplication(
    settings,
    backend,
    fromFileUrl(new URL("../../web/dist/", import.meta.url)),
  );
  const stop = app.stop.bind(app);
  const emit = app.connections.content.bind(app.connections);
  app.connections.content = (id, event, clock) => {
    if (clock) emit!(id, event, clock);
    else replay.publish(id, event);
  };
  app.stop = scope.defer("core backend application", stop);
  return {
    app,
    session,
    page,
    url: `http://127.0.0.1:${app.server.addr.port}`,
  };
}
