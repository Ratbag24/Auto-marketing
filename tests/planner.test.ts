import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validatePlannedItem } from "../src/ai/planner.js";
import { composeSocialText, CHANNEL_LIMITS } from "../src/channels/types.js";
import type { PlannedItem } from "../src/ai/schemas.js";
import type { Channel, ContentItem } from "../src/db/types.js";

const base: PlannedItem = {
  channel: "x",
  pillar: "Access",
  subject: "",
  body: "Evening appointments every weekday. Book online in under a minute.",
  hashtags: ["dentistry"],
  cta: "Book online",
  day_offset: 1,
  hour_local: 9,
  rationale: "test",
};

const allowed: Channel[] = ["email", "x", "linkedin"];
const pillars = ["Access", "Prevention"];

describe("planned item validation", () => {
  test("accepts a well-formed item", () => {
    assert.deepEqual(validatePlannedItem(base, allowed, pillars), { ok: true });
  });

  test("rejects a channel the business has not enabled", () => {
    const result = validatePlannedItem(
      { ...base, channel: "instagram" },
      allowed,
      pillars,
    );
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /not enabled/);
  });

  test("rejects copy over the channel's character limit", () => {
    const result = validatePlannedItem(
      { ...base, body: "a".repeat(CHANNEL_LIMITS.x.maxBodyChars + 1) },
      allowed,
      pillars,
    );
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /exceeds x limit/);
  });

  test("accepts copy exactly at the limit", () => {
    const result = validatePlannedItem(
      { ...base, body: "a".repeat(CHANNEL_LIMITS.x.maxBodyChars) },
      allowed,
      pillars,
    );
    assert.equal(result.ok, true);
  });

  test("rejects email with no subject line", () => {
    const result = validatePlannedItem(
      { ...base, channel: "email", subject: "   ", hashtags: [] },
      allowed,
      pillars,
    );
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /subject/);
  });

  test("rejects too many hashtags", () => {
    const result = validatePlannedItem(
      { ...base, hashtags: ["a", "b", "c", "d"] },
      allowed,
      pillars,
    );
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /hashtags/);
  });

  test("rejects an empty body", () => {
    const result = validatePlannedItem({ ...base, body: "   " }, allowed, pillars);
    assert.equal(result.ok, false);
  });

  test("rejects an unknown content pillar", () => {
    const result = validatePlannedItem(
      { ...base, pillar: "Invented" },
      allowed,
      pillars,
    );
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /unknown pillar/);
  });

  // Placeholder text reaching a live audience is the most embarrassing
  // failure this system could have, so each shape is pinned.
  for (const placeholder of [
    "Call us on [insert number] today",
    "Save XX% this month only",
    "Lorem ipsum dolor sit amet",
    "Visit [your website] to book",
  ]) {
    test(`rejects placeholder text: ${placeholder.slice(0, 24)}`, () => {
      const result = validatePlannedItem(
        { ...base, body: placeholder },
        allowed,
        pillars,
      );
      assert.equal(result.ok, false);
      assert.match((result as { reason: string }).reason, /placeholder/);
    });
  }

  test("does not mistake ordinary bracketed prose for a placeholder", () => {
    const result = validatePlannedItem(
      { ...base, body: "Our hygienist (Dr Patel) now works Saturdays." },
      allowed,
      pillars,
    );
    assert.equal(result.ok, true);
  });
});

describe("social text composition", () => {
  const item = (over: Partial<ContentItem>): ContentItem =>
    ({
      id: "i",
      business_id: "b",
      plan_run_id: null,
      channel: "x",
      pillar: "Access",
      subject: null,
      body: "Short post.",
      hashtags: "[]",
      cta: null,
      scheduled_at: "",
      status: "scheduled",
      delivery: null,
      external_id: null,
      published_at: null,
      attempts: 0,
      error: null,
      created_at: "",
      updated_at: "",
      ...over,
    }) as ContentItem;

  test("appends hashtags with a # prefix", () => {
    const text = composeSocialText(item({ hashtags: '["dentistry","care"]' }));
    assert.equal(text, "Short post.\n\n#dentistry #care");
  });

  test("does not double the # when the model already included one", () => {
    const text = composeSocialText(item({ hashtags: '["#dentistry"]' }));
    assert.equal(text, "Short post.\n\n#dentistry");
  });

  test("drops hashtags rather than breaching the character limit", () => {
    const body = "a".repeat(CHANNEL_LIMITS.x.maxBodyChars - 2);
    const text = composeSocialText(item({ body, hashtags: '["averylonghashtag"]' }));
    assert.equal(text, body);
    assert.ok(text.length <= CHANNEL_LIMITS.x.maxBodyChars);
  });

  test("returns the body unchanged when there are no hashtags", () => {
    assert.equal(composeSocialText(item({})), "Short post.");
  });
});
