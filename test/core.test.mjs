import test from "node:test";
import assert from "node:assert/strict";
import { createExport, demoCatalog, matchRows, parseTrackRows, scoreCandidate } from "../src/core.mjs";

test("parses numbered artist-title rows and remix names", () => {
  const rows = parseTrackRows("1. Peggy Gou - It Goes Like Nanana\n2) Mochakk - Jealous (Extended Mix)");

  assert.equal(rows.length, 2);
  assert.equal(rows[0].artist, "Peggy Gou");
  assert.equal(rows[0].title, "It Goes Like Nanana");
  assert.equal(rows[1].remix, "Extended Mix");
  assert.equal(rows[1].title, "Jealous");
});

test("scores exact-ish Beatport candidates above weak candidates", () => {
  const row = parseTrackRows("Bicep - Glue")[0];
  const exact = {
    artist: "Bicep",
    title: "Glue",
    mix: "Original Mix"
  };
  const weak = {
    artist: "Mall Grab",
    title: "Love Reigns",
    mix: "Original Mix"
  };

  assert.ok(scoreCandidate(row, exact) > scoreCandidate(row, weak));
});

test("auto-accepts high confidence rows and exports accepted order", () => {
  const matched = matchRows(parseTrackRows("Peggy Gou - It Goes Like Nanana\nBicep - Glue"), demoCatalog);

  assert.equal(matched[0].status, "accepted");
  assert.equal(matched[1].status, "accepted");
  assert.match(createExport(matched), /1\. Peggy Gou - It Goes Like Nanana/);
  assert.match(createExport(matched), /2\. Bicep - Glue/);
});
