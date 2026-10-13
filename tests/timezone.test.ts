import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isValidTimeZone,
  localHour,
  safeTimeZone,
  scheduleAt,
  zonedWallClockToUtc,
} from "../src/util/timezone.js";

const utc = (y: number, m: number, d: number, h: number, zone: string) =>
  zonedWallClockToUtc(y, m, d, h, 0, zone).toISOString();

describe("wall clock to UTC", () => {
  // The whole point of the fix: 9am must mean 9am to the audience, in summer
  // and in winter alike.
  test("London 9am is 08:00Z in summer and 09:00Z in winter", () => {
    assert.equal(utc(2026, 7, 15, 9, "Europe/London"), "2026-07-15T08:00:00.000Z");
    assert.equal(utc(2026, 1, 15, 9, "Europe/London"), "2026-01-15T09:00:00.000Z");
  });

  test("New York 9am shifts with daylight saving", () => {
    assert.equal(utc(2026, 7, 15, 9, "America/New_York"), "2026-07-15T13:00:00.000Z");
    assert.equal(utc(2026, 1, 15, 9, "America/New_York"), "2026-01-15T14:00:00.000Z");
  });

  // Southern hemisphere DST runs the other way round, and 9am local lands on
  // the previous UTC day - the case a naive implementation gets wrong.
  test("Sydney 9am falls on the previous UTC day", () => {
    assert.equal(utc(2026, 1, 15, 9, "Australia/Sydney"), "2026-01-14T22:00:00.000Z");
    assert.equal(utc(2026, 7, 15, 9, "Australia/Sydney"), "2026-07-14T23:00:00.000Z");
  });

  test("handles half-hour and 45-minute offsets", () => {
    assert.equal(utc(2026, 7, 15, 9, "Asia/Kolkata"), "2026-07-15T03:30:00.000Z");
    assert.equal(utc(2026, 7, 15, 9, "Asia/Kathmandu"), "2026-07-15T03:15:00.000Z");
  });

  test("9am on a clock-change day is still 9am", () => {
    assert.equal(utc(2026, 10, 25, 9, "Europe/London"), "2026-10-25T09:00:00.000Z");
    assert.equal(utc(2026, 3, 29, 9, "Europe/London"), "2026-03-29T08:00:00.000Z");
  });

  test("every hour round-trips in every zone tested", () => {
    const zones = [
      "UTC",
      "Europe/London",
      "America/New_York",
      "America/Los_Angeles",
      "Australia/Sydney",
      "Asia/Kolkata",
    ];
    const mismatches: string[] = [];
    for (const zone of zones) {
      for (const [month, day] of [[1, 15], [7, 15], [10, 25], [12, 31]]) {
        for (let hour = 0; hour < 24; hour += 1) {
          const instant = zonedWallClockToUtc(2026, month!, day!, hour, 0, zone);
          const back = localHour(instant.toISOString(), zone);
          if (back !== hour) mismatches.push(`${zone} ${month}/${day} ${hour}`);
        }
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test("an hour that daylight saving skips lands just after the jump", () => {
    // 01:30 on 2026-03-29 does not exist in London. Any answer is a
    // compromise; the requirement is that it does not throw or go backwards.
    const instant = zonedWallClockToUtc(2026, 3, 29, 1, 30, "Europe/London");
    assert.equal(instant.toISOString(), "2026-03-29T01:30:00.000Z");
    assert.equal(localHour(instant.toISOString(), "Europe/London"), 2);
  });
});

describe("invalid zones", () => {
  test("recognises real zones and rejects nonsense", () => {
    assert.equal(isValidTimeZone("Europe/London"), true);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Mars/Olympus"), false);
    assert.equal(isValidTimeZone(""), false);
  });

  test("falls back to UTC rather than throwing mid-sweep", () => {
    assert.equal(safeTimeZone("Mars/Olympus"), "UTC");
    assert.equal(safeTimeZone(null), "UTC");
    assert.equal(safeTimeZone("Europe/London"), "Europe/London");
    assert.doesNotThrow(() => zonedWallClockToUtc(2026, 7, 15, 9, 0, "Nope/Nope"));
  });
});

describe("scheduleAt", () => {
  test("schedules N days ahead at the local hour", () => {
    const from = new Date("2026-07-15T22:00:00Z"); // 23:00 London
    const when = scheduleAt(from, 3, 9, "Europe/London");
    assert.equal(when.toISOString(), "2026-07-18T08:00:00.000Z");
    assert.equal(localHour(when.toISOString(), "Europe/London"), 9);
  });

  test("day offset counts local days, not UTC days", () => {
    // 22:00 UTC is already the next day in Sydney, so offset 0 means today
    // there, not today in UTC.
    const from = new Date("2026-07-15T22:00:00Z"); // 2026-07-16 08:00 Sydney
    const when = scheduleAt(from, 0, 9, "Australia/Sydney");
    assert.equal(localHour(when.toISOString(), "Australia/Sydney"), 9);
    assert.equal(when.toISOString(), "2026-07-15T23:00:00.000Z");
  });

  test("the chosen hour survives a daylight-saving change mid-window", () => {
    // Planning on 20 Oct for 10 days out crosses the UK clock change.
    const from = new Date("2026-10-20T10:00:00Z");
    for (const offset of [1, 5, 10]) {
      const when = scheduleAt(from, offset, 9, "Europe/London");
      assert.equal(
        localHour(when.toISOString(), "Europe/London"),
        9,
        `offset ${offset} should still be 9am local`,
      );
    }
  });
});
