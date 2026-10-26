import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAppServer, extractImageText } from "../server/local-server.mjs";

test("extracts text from the raw Responses API output after reasoning items", async (t) => {
  const existing = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  t.after(() => {
    if (existing === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = existing;
  });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.text.format.type, "json_schema");
    assert.equal(request.text.format.strict, true);
    assert.ok(request.text.format.schema.properties.tracks.items.required.includes("artist"));
    return new Response(JSON.stringify({
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify({
        raw_text: "Artist - Track", tracks: [{ artist: "Artist", title: "Track", position: 7, source_text: "Artist - Track", uncertain: false }]
      }) }] }
    ]
  }), { status: 200 });
  });
  assert.deepEqual(await extractImageText("data:image/png;base64,test"), {
    rawText: "Artist - Track",
    tracks: [{ artist: "Artist", title: "Track", position: 7, sourceText: "Artist - Track", uncertain: false }],
    validation: { passes: 1, issues: [], warning: "", complete: true }
  });
});

async function streamRequest() {
  const request = {
    method: "POST", url: "/api/extract-image", headers: { accept: "application/x-ndjson" },
    async *[Symbol.asyncIterator]() { yield JSON.stringify({ imageDataUrl: "data:image/png;base64,test" }); }
  };
  const response = new EventEmitter();
  let body = "";
  response.writeHead = (status) => { response.statusCode = status; response.headersSent = true; };
  response.write = (chunk) => { body += chunk; };
  await new Promise((resolve) => {
    response.end = (chunk = "") => { body += chunk; resolve(); };
    createAppServer().emit("request", request, response);
  });
  return body.trim().split("\n").map((line) => JSON.parse(line));
}

function useTestKey(t) {
  const existing = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  t.after(() => {
    if (existing === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = existing;
  });
}

test("API streams real read/check stages followed by structured result", async (t) => {
  useTestKey(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      raw_text: "Artist - Track", tracks: [{ artist: "Artist", title: "Track", position: null, source_text: "Artist - Track", uncertain: false }]
    }) }] }]
  })));
  const events = await streamRequest();
  assert.deepEqual(events.map((event) => event.stage || event.type), ["reading", "validating", "result"]);
  assert.equal(events.at(-1).tracks[0].title, "Track");
});

test("API terminates a failed stream with an error event", async (t) => {
  useTestKey(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 }));
  const events = await streamRequest();
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).error, "Quota exceeded");
});

test("image extraction fails clearly when OpenAI API key is missing", async () => {
  const existing = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  await assert.rejects(
    () => extractImageText("data:image/png;base64,iVBORw0KGgo="),
    /OPENAI_API_KEY is not configured/
  );

  if (existing) process.env.OPENAI_API_KEY = existing;
});
