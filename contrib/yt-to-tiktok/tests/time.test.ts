import test from "node:test";
import assert from "node:assert/strict";
import { ageMinutes, backoffMs, jitter, parseIso8601Duration, sqlTimestampIn } from "../src/util/time.js";

test("parses the ISO-8601 durations the YouTube API returns", () => {
  assert.equal(parseIso8601Duration("PT30S"), 30);
  assert.equal(parseIso8601Duration("PT1M"), 60);
  assert.equal(parseIso8601Duration("PT1M30S"), 90);
  assert.equal(parseIso8601Duration("PT1H"), 3600);
  assert.equal(parseIso8601Duration("PT1H2M3S"), 3723);
  assert.equal(parseIso8601Duration("P1DT2H"), 93600);
  assert.equal(parseIso8601Duration("PT0S"), 0);
});

test("handles fractional seconds by rounding", () => {
  assert.equal(parseIso8601Duration("PT1.5S"), 2);
  assert.equal(parseIso8601Duration("PT10.4S"), 10);
});

test("rejects durations in years or months, whose length is not fixed", () => {
  assert.equal(parseIso8601Duration("P1Y"), null);
  assert.equal(parseIso8601Duration("P1M"), null);
});

test("rejects junk instead of guessing a duration", () => {
  for (const bad of ["", "P", "PT", "abc", "1H", "PTS", "P1", "  "]) {
    assert.equal(parseIso8601Duration(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("tolerates surrounding whitespace", () => {
  assert.equal(parseIso8601Duration("  PT45S  "), 45);
});

test("backoff doubles per attempt and then holds at the ceiling", () => {
  assert.equal(backoffMs(1, 1000, 60_000), 1000);
  assert.equal(backoffMs(2, 1000, 60_000), 2000);
  assert.equal(backoffMs(3, 1000, 60_000), 4000);
  assert.equal(backoffMs(7, 1000, 60_000), 60_000);
  assert.equal(backoffMs(100, 1000, 60_000), 60_000);
});

test("backoff treats a zero or negative attempt as the first", () => {
  assert.equal(backoffMs(0, 5000), 5000);
  assert.equal(backoffMs(-3, 5000), 5000);
});

test("jitter stays inside +/-20%", () => {
  assert.equal(jitter(1000, () => 0), 800);
  assert.equal(jitter(1000, () => 1), 1200);
  assert.equal(jitter(1000, () => 0.5), 1000);
});

test("sqlTimestampIn emits a SQLite-comparable 'YYYY-MM-DD HH:MM:SS' string", () => {
  const ts = sqlTimestampIn(0, Date.parse("2026-08-30T10:20:30.999Z"));
  assert.equal(ts, "2026-08-30 10:20:30");
  assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("sqlTimestampIn offsets into the future", () => {
  const base = Date.parse("2026-08-30T10:00:00Z");
  assert.equal(sqlTimestampIn(90_000, base), "2026-08-30 10:01:30");
});

test("ageMinutes measures elapsed time and treats junk as infinitely old", () => {
  const now = Date.parse("2026-08-30T10:00:00Z");
  assert.equal(ageMinutes("2026-08-30T09:30:00Z", now), 30);
  assert.equal(ageMinutes("2026-08-30T10:00:00Z", now), 0);
  assert.equal(ageMinutes("nonsense", now), Number.POSITIVE_INFINITY);
});
