import { describe, expect, test } from "bun:test";

import type { ServerHalf } from "../../runtime/extension.ts";
import { serverExtension } from "../../runtime/server/slice.ts";
import type { HtmlPlugs } from "../html/contract.ts";
import type { MarkdownPlugs } from "./contract.ts";
import { server } from "./server.ts";

/**
 * What a format's plugs make a compile error that no other slice's suite holds, one test each:
 * the code under `@ts-expect-error` is what must not compile, and the line after it runs, to say
 * what that code would do. A format declares its renderers and, for Markdown, the plan's links:
 * its server half takes no route and no workflow it does not declare.
 */

describe("a format's server half fills what its plugs declare, and nothing it does not", () => {
  test("a Markdown server half without linkedDocs does not compile: the plan's links would name no document", () => {
    const { linkedDocs: _linked, ...rest } = server;
    // @ts-expect-error -- the plugs declare `linkedDocs: true`.
    const half: ServerHalf<MarkdownPlugs> = rest;

    expect(serverExtension(half).linkedDocs).toBeUndefined();
  });

  test("a server half proposing linked documents its plugs do not declare does not compile", () => {
    // @ts-expect-error -- the HTML format declares no `linkedDocs`.
    const half: ServerHalf<HtmlPlugs> = { id: "html", linkedDocs: server.linkedDocs };

    expect(serverExtension(half).linkedDocs).toBe(server.linkedDocs);
  });

  test("routes on a format that declares none do not compile: they would be mounted", () => {
    // @ts-expect-error -- the Markdown format declares no route.
    const half: ServerHalf<MarkdownPlugs> = { ...server, routes: {} };

    expect(serverExtension(half).routes).toBeDefined();
  });

  test("a workflow on a format that owns and hears no event does not compile: it would join the table", () => {
    const half: ServerHalf<MarkdownPlugs> = {
      ...server,
      // @ts-expect-error -- the Markdown format owns and hears no event.
      workflow: {
        events: {},
        rules: [],
        samples: {},
        transitions: {},
        reactions: {},
        region: () => Promise.resolve({ id: "markdown", state: "closed", data: {} }),
        segment: () => null,
        line: () => "markdown: closed",
      },
    };

    expect(serverExtension(half).workflow?.events).toEqual([]);
  });
});
