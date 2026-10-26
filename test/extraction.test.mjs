import test from "node:test";
import assert from "node:assert/strict";
import { runExtractionHarness, validateTracks } from "../src/extraction.mjs";
import { matchRows, parseTrackRows, structuredTrackRows, createExport } from "../src/core.mjs";

const song = (overrides = {}) => ({ artist: "Bicep", title: "Glue", position: 12, source_text: "12 Glue Bicep", uncertain: false, ...overrides });
const result = (...tracks) => ({ raw_text: "12 Glue Bicep", tracks });

test("complete structured songs preserve title-first layout and rank without reparsing", async () => {
  let calls = 0;
  const extracted = await runExtractionHarness(async () => { calls++; return result(song()); });
  assert.equal(calls, 1);
  const [row] = matchRows(structuredTrackRows(extracted.tracks));
  assert.equal(row.artist, "Bicep");
  assert.equal(row.title, "Glue");
  assert.equal(row.position, 12);
  assert.equal(row.status, "review");
  assert.deepEqual(row.candidates, []);
});

test("missing artist triggers one repair pass with actionable feedback", async () => {
  let calls = 0;
  const stages = [];
  const extracted = await runExtractionHarness(async (feedback) => {
    calls++;
    if (!feedback) return result(song({ artist: "" }));
    assert.ok(feedback.issues[0].issues.includes("Missing artist"));
    return result(song());
  }, (stage) => stages.push(stage));
  assert.equal(calls, 2);
  assert.equal(extracted.validation.complete, true);
  assert.deepEqual(stages, ["reading", "validating", "repairing"]);
});

test("persistent missing fields remain blank and flagged after two reads", async () => {
  let calls = 0;
  const extracted = await runExtractionHarness(async () => { calls++; return result(song({ title: " " })); });
  assert.equal(calls, 2);
  assert.equal(extracted.tracks[0].title, "");
  assert.equal(extracted.validation.complete, false);
  assert.deepEqual(extracted.validation.issues[0].issues, ["Missing title"]);
});

test("a retry cannot silently drop a problematic song", async () => {
  const extracted = await runExtractionHarness(async (feedback) => feedback
    ? result(song())
    : result(song(), song({ position: 13, title: "", artist: "Another artist" })));
  assert.equal(extracted.tracks.length, 2);
  assert.match(extracted.validation.warning, /less complete/);
});

test("repair failure preserves first read for manual review", async () => {
  const extracted = await runExtractionHarness(async (feedback) => {
    if (feedback) throw new Error("upstream unavailable");
    return result(song({ uncertain: true }));
  });
  assert.equal(extracted.tracks.length, 1);
  assert.match(extracted.validation.warning, /could not finish/);
});

test("empty image has bounded retries and no invented songs", async () => {
  let calls = 0;
  const extracted = await runExtractionHarness(async () => { calls++; return result(); });
  assert.equal(calls, 2);
  assert.deepEqual(extracted.tracks, []);
  assert.equal(extracted.validation.complete, false);
});

test("chart positions may be absent, but invalid or duplicate ranks need review", () => {
  assert.deepEqual(validateTracks([song({ position: null })]), []);
  const issues = validateTracks([song(), song(), song({ position: -1 })]);
  assert.equal(issues.length, 3);
  assert.match(issues[0].issues.join(), /Repeated/);
  assert.match(issues[2].issues.join(), /Invalid/);
});

test("manual parser preserves numeric artist names and title-by-artist order", () => {
  const rows = parseTrackRows("12. Glue by Bicep\n13. 808 State - Pacific State\n14. Jay-Z - Song");
  assert.equal(rows[0].artist, "Bicep");
  assert.equal(rows[0].position, 12);
  assert.equal(rows[1].artist, "808 State");
  assert.equal(rows[2].artist, "Jay-Z");
  const reviewed = matchRows(rows).map((row) => ({ ...row, status: "accepted" }));
  assert.match(createExport(reviewed), /1\. Bicep - Glue/);
});
