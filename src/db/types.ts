export type Channel = "email" | "x" | "linkedin" | "facebook" | "instagram";

export const ALL_CHANNELS: Channel[] = [
  "email",
  "x",
  "linkedin",
  "facebook",
  "instagram",
];

export type ApprovalMode = "auto" | "review";

export type ItemStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "skipped";

export interface Business {
  id: string;
  name: string;
  website: string | null;
  one_liner: string;
  audience: string;
  tone: string;
  timezone: string;
  approval_mode: ApprovalMode;
  autopilot: number;
  weekly_volume: number;
  created_at: string;
  updated_at: string;
}

export interface Segment {
  name: string;
  pains: string[];
  hooks: string[];
}

export interface Pillar {
  name: string;
  description: string;
}

export interface Voice {
  guidelines: string[];
  avoid: string[];
}

/** Row shape as stored (JSON columns are strings). */
export interface BrandProfileRow {
  id: string;
  business_id: string;
  version: number;
  positioning: string;
  value_props: string;
  segments: string;
  pillars: string;
  voice: string;
  created_at: string;
}

/** Decoded shape used by the rest of the app. */
export interface BrandProfile {
  id: string;
  business_id: string;
  version: number;
  positioning: string;
  value_props: string[];
  segments: Segment[];
  pillars: Pillar[];
  voice: Voice;
  created_at: string;
}

export interface ContentItem {
  id: string;
  business_id: string;
  plan_run_id: string | null;
  channel: Channel;
  pillar: string;
  subject: string | null;
  body: string;
  hashtags: string;
  cta: string | null;
  scheduled_at: string;
  status: ItemStatus;
  delivery: "live" | "simulated" | null;
  external_id: string | null;
  published_at: string | null;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetricRow {
  id: string;
  content_item_id: string;
  business_id: string;
  channel: Channel;
  captured_at: string;
  impressions: number;
  clicks: number;
  opens: number;
  reactions: number;
  shares: number;
  comments: number;
  conversions: number;
  simulated: number;
}

export interface PlanRun {
  id: string;
  business_id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "succeeded" | "failed";
  items_created: number;
  strategy_note: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  error: string | null;
}

export interface EventRow {
  id: string;
  business_id: string | null;
  level: "info" | "warn" | "error";
  type: string;
  message: string;
  data: string | null;
  created_at: string;
}
