import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  blocksFromItems,
  escapeHtml,
  loadPrintableThread,
  renderPrintDocument,
} from "./print.ts";

describe("blocksFromItems", () => {
  it("keeps the conversation and skips tool noise", () => {
    const blocks = blocksFromItems([
      {
        type: "user_message",
        quoted_text: "earlier line",
        content: [
          { type: "input_text", text: "Where is the truck?" },
          { type: "input_tag", text: "North depot" },
        ],
        attachments: [{ name: "route.xlsx" }],
      },
      { type: "workflow", workflow: { type: "reasoning", tasks: [] } },
      { type: "end_of_turn" },
      {
        type: "assistant_message",
        content: [
          {
            type: "output_text",
            text: "It is at the depot.",
            annotations: [
              { source: { type: "url", title: "Fleet", url: "https://fleet.example/trucks" } },
            ],
          },
        ],
      },
      {
        type: "client_tool_call",
        name: "show_html",
        status: "pending",
      },
      {
        type: "client_tool_call",
        name: "show_html",
        status: "completed",
      },
      {
        type: "client_tool_call",
        name: "show_map",
        status: "completed",
      },
      { type: "widget", copy_text: "Three stops" },
      {
        type: "structured_input",
        inputs: [{ question: "Which day?", answer: { values: ["Tuesday"], skipped: false } }],
      },
    ]);

    assert.deepEqual(blocks, [
      {
        role: "you",
        text: "> earlier line\n\nWhere is the truck?\nNorth depot\n\nAttachment: route.xlsx",
      },
      {
        role: "assistant",
        text: "It is at the depot.\n\nSources:\n- Fleet (https://fleet.example/trucks)",
      },
      { role: "note", text: "Showed a report in the side panel." },
      { role: "note", text: "Showed a map." },
      { role: "assistant", text: "Three stops" },
      { role: "note", text: "Which day?\nTuesday" },
    ]);
  });

  it("does not repeat a source that is already in the message", () => {
    const blocks = blocksFromItems([
      {
        type: "assistant_message",
        content: [
          {
            text: "See https://fleet.example/trucks",
            annotations: [{ source: { url: "https://fleet.example/trucks" } }],
          },
        ],
      },
    ]);
    assert.equal(blocks[0]?.text, "See https://fleet.example/trucks");
  });
});

describe("renderPrintDocument", () => {
  it("escapes message text and renders a short markdown subset", () => {
    const html = renderPrintDocument({
      title: "Fleet <report>",
      printedAt: new Date("2026-10-26T12:00:00Z"),
      blocks: [
        {
          role: "assistant",
          text: "Use <script>alert(1)</script> and **bold** `code`\n\nSee https://fleet.example/a.\n\n```\n<tag>\n```",
        },
      ],
    });

    assert.ok(html.includes("<title>Fleet &lt;report&gt;</title>"));
    assert.ok(html.includes("<h1>Fleet &lt;report&gt;</h1>"));
    assert.equal(html.includes("<script>"), false);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("<strong>bold</strong>"));
    assert.ok(html.includes("<code>code</code>"));
    assert.ok(html.includes('<a href="https://fleet.example/a">https://fleet.example/a</a>.'));
    assert.ok(html.includes("<pre><code>&lt;tag&gt;</code></pre>"));
    assert.equal(escapeHtml(`"'&<>`), "&quot;&#39;&amp;&lt;&gt;");
  });
});

describe("loadPrintableThread", () => {
  it("follows later pages in ascending order and stops when the cursor repeats", async () => {
    const calls: unknown[] = [];
    const post = (body: unknown) => {
      calls.push(body);
      const request = body as { type: string };
      if (request.type === "threads.get_by_id") {
        return Promise.resolve({
          title: "  Morning route  ",
          items: {
            data: [{ type: "user_message", content: [{ text: "First" }] }],
            has_more: true,
            after: "cursor-1",
          },
        });
      }
      return Promise.resolve({
        data: [{ type: "assistant_message", content: [{ text: "Second" }] }],
        has_more: true,
        after: "cursor-1",
      });
    };

    const printable = await loadPrintableThread("thread-1", post);

    assert.equal(printable.title, "Morning route");
    assert.deepEqual(printable.blocks.map((block) => block.text), ["First", "Second"]);
    assert.deepEqual(calls[1], {
      type: "items.list",
      params: {
        thread_id: "thread-1",
        order: "asc",
        after: "cursor-1",
        limit: 100,
      },
    });
    assert.equal(calls.length, 2);
  });

  it("stops after the page cap", async () => {
    let pages = 0;
    const post = (body: unknown) => {
      const request = body as { type: string; params?: { after?: string } };
      if (request.type === "threads.get_by_id") {
        return Promise.resolve({
          title: "Long",
          items: {
            data: [{ type: "user_message", content: [{ text: "Start" }] }],
            has_more: true,
            after: "0",
          },
        });
      }
      pages += 1;
      const after = request.params?.after ?? "0";
      return Promise.resolve({
        data: [{ type: "assistant_message", content: [{ text: `Page ${after}` }] }],
        has_more: true,
        after: String(Number(after) + 1),
      });
    };

    const printable = await loadPrintableThread("thread-1", post, { maxPages: 3 });
    assert.equal(pages, 3);
    assert.equal(printable.blocks.length, 4);
  });
});
