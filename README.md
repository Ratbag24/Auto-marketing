# Auto-marketing

An autonomous marketing engine. A business gives it five fields and a website
address; it reads the site, generates a brand strategy, writes a multi-channel
content calendar, publishes on schedule, measures what happened on both the
channels and the website, and feeds all of it back into the next planning cycle.

It also watches the website itself: whether it is up, how fast it responds, and
whether it is quietly broken.

It is built to run unattended on one small server, with no queue service, no
worker fleet and no cron daemon.

```
  five fields ─┐
               ├─► brand profile ──► campaign plan ──► publish ──► measure
  your website ┘         ▲                                │           │
       │                 └──────── performance feedback ◄─┴───────────┘
       │
       ├─► content crawl ──► what you actually offer, and SEO problems
       ├─► health checks ──► up / slow / broken / content missing
       └─► visitor tracking ──► who, where, how they arrived, what converted
```

## Quick start

```sh
npm install
cp .env.example .env     # add ANTHROPIC_API_KEY
npm run build
npm run seed             # optional: demo business with simulated history
npm start                # dashboard on http://localhost:8787
```

`npm run seed` needs no API key and no channel credentials. It creates a demo
business with a fortnight of content and a fortnight of simulated performance,
so you can see the whole product working before wiring anything up.

Requires Node 22.5+ (it uses the built-in `node:sqlite`).

## Your website

Connecting a website is one field in the dashboard, and it turns on three
things at once.

**It reads your content.** A polite same-origin crawler (robots.txt honoured,
40 pages, one request at a time) extracts every page's title, description,
headings and text. That content is then fed into brand profile generation,
which is the single biggest quality lever in the product: a strategy built from
your real site beats one inferred from a one-line description. The same pass
reports the SEO problems worth fixing - missing titles and descriptions, thin
pages, absent H1s, no mobile viewport, images without alt text.

**It watches whether the site works.** Every five minutes: is it reachable,
what status code, how long did it take, how long until the TLS certificate
expires, and - if you give it a string to look for - is the page still actually
rendering its content. That last check catches the nastiest failure mode, where
the server returns a confident 200 for a page that is empty or broken. Results
are classified as `up`, `slow`, `broken`, `content_missing` or `down`, and two
consecutive failures open an incident so a single blip does not cry wolf.

**It shows you the audience.** A small tracking snippet reports pageviews.
From those you get visitors and sessions over time, countries and regions,
device and browser mix, how people arrived (direct, search, social, referral),
your most-read pages, pages per visit, time on site, and goal completions.

### Attribution

Links to your own site inside published posts are rewritten at send time with
UTM parameters identifying the exact content item. When that visitor lands, the
visit is joined back to the post that produced it, and the dashboard shows
which posts actually brought people - and which brought people who converted.
This is what turns engagement metrics into something connected to revenue.

Only your own origin is rewritten; third-party links are left exactly as
written.

### Privacy

**No IP address is ever stored.** Visitors are identified by a salted hash, and
the salt rotates daily, so the same person is unrecognisable across days and
nothing in the database can be traced back to an address. The snippet sets no
cookies and reads nothing but a per-tab session id. Query strings are stripped
from stored paths. Bots are dropped before they reach the statistics.

That design is intended to avoid needing a cookie banner in most
jurisdictions - confirm that for yours before relying on it.

### Where location comes from

Country is read from whichever edge proxy sits in front of the server
(Cloudflare, Vercel, Fastly, CloudFront are all recognised). With no such
proxy, the browser's own timezone gives a coarse country and region at no cost
and with no IP lookup. Unmapped timezones stay unknown rather than being
guessed.

If you would rather pull from Google Analytics than run the snippet, that is a
GA4 Data API importer writing into the same `visits` table - the dashboard and
the attribution join would not change.

## The five fields

Onboarding asks for exactly this much:

| Field | Example |
|---|---|
| Business name | Northgate Dental |
| What you sell | A family dental practice with evening and weekend appointments |
| Who you sell to | Working adults and families within 10 miles |
| How you want to sound | Warm, plain-spoken, practical |
| Website *(optional)* | https://… |

From those, the engine generates a **brand profile**: positioning, value
propositions, audience segments, four to six content pillars, and a voice guide
including an explicit list of things never to say. That profile is generated
once and reused by every planning run afterwards, which is what makes the
ongoing input requirement effectively zero.

## How the loop works

**Planning** runs weekly per business, or early if the calendar is about to run
dry. It reads the brand profile plus a performance brief and returns a dated
calendar of finished, publishable copy.

**Publishing** sweeps every five minutes for items that are due. Three gates
must all be open before anything leaves the server:

1. `PUBLISHING_ENABLED` — the global kill switch
2. the business's own `autopilot` flag
3. the item being in `scheduled` state, not `draft`

**Measurement** polls each published item for up to 30 days, appending a row per
sweep rather than overwriting, so performance is a time series. Alongside it,
site checks run every five minutes and crawls weekly.

**Optimisation** turns those metrics into the next planning brief: engagement
rate by channel, by content pillar and by hour posted, plus the strongest and
weakest recent pieces. Below eight measured posts it reports a cold start and
tells the planner to spread coverage evenly instead of optimising noise. Past
that it steers toward what works while explicitly reserving at least 20% of each
cycle for untested angles, so the calendar does not collapse into one repeated
format.

All of the optimisation arithmetic lives in `src/engine/optimizer.ts` as plain,
auditable code. The model does the creative work; the evidence is computed.

## Channels

Each channel is an adapter behind one interface. **A channel without credentials
runs in simulation mode**: the post is recorded and metrics are generated, but
nothing is sent. Every simulated row is flagged in the database, surfaced as a
banner on the dashboard, and discounted in the planner's brief. It exists so the
full loop is testable before platform access is granted — it is never presented
as real audience behaviour.

| Channel | Status | What it takes to go live |
|---|---|---|
| **Email** (Resend) | Implemented | An API key and a verified domain. No approval. |
| **X** | Implemented | A paid API tier plus OAuth 1.0a credentials. |
| **LinkedIn** | Implemented | Community Management API — partner approval. |
| **Facebook** | Implemented | A Page token with `pages_manage_posts` — App Review. |
| **Instagram** | Deliberately inert | Feed posts require an image or video; there is no text-only post. The adapter reports itself unconfigured rather than queueing posts that can only fail. Add media generation before enabling it. |

Email is the one with no gatekeeper, the best measurement, and the fastest path
to revenue. Start there.

The OAuth 1.0a signing used by X is verified in the test suite against X's own
published example signature, because a silent signing bug means every post fails
with a 401.

## What it costs to run

Per business, on the default settings (weekly planning, `claude-opus-5-5`):

| Item | Cost |
|---|---|
| Brand profile | ~$0.05, once |
| Planning run | ~$0.15–0.20, weekly |
| **Model total** | **~$0.70–0.90 per business per month** |

The brand profile and standing rules sit behind a prompt cache breakpoint, so
repeat planning runs read most of their input at roughly a tenth of the input
rate. The dashboard shows measured token spend per business rather than an
estimate.

Infrastructure is one process and one SQLite file. A $5–6/month instance runs
many businesses comfortably. There is no separate database, queue or scheduler
to pay for.

The obvious cost lever if you need one: set `MODEL=claude-sonnet-5-5`, which is
5× cheaper on input and 2× on output. Check the output quality against your own
brand before making that trade — it is a quality decision, not just a billing
one.

## Brand safety

Generated copy goes to a real audience, so the controls are explicit:

- **Review mode** (`approval_mode: "review"`) holds every new item as a draft
  until approved in the dashboard. New businesses default to this for the first
  cycle; switching to automatic is one dropdown.
- **Two kill switches**: `PUBLISHING_ENABLED` stops everything globally;
  per-business `autopilot` stops one account. Both take effect on the next sweep.
- **Hard validation** rejects anything over a channel's character limit, with too
  many hashtags, with an unknown content pillar, with no subject line on an
  email, or containing placeholder text (`[insert link]`, `XX%`, lorem ipsum).
  Rejections are counted and logged rather than silently dropped.
- **Prompt rules** forbid inventing statistics, prices, awards, testimonials or
  guarantees the business has not supplied.
- **An append-only event log** records every publish, failure and planning run.

A rejected item is never published. Validation runs before anything is written
to the calendar.

## Dashboard

`http://localhost:8787` — two halves.

*Marketing:* reach and engagement trends, engagement rate by channel, pillar and
hour posted, the live queue, the review queue, channel status, model spend and
the activity log.

*Website:* current status with uptime and TLS expiry, response time history,
incident log, visitors over time, countries, traffic sources, device mix,
most-read pages, the posts that brought visitors, and the content problems found
on the site.

Light and dark themes, no build step, no chart library, no CDN.

Access is guarded by `ADMIN_TOKEN`. If it is unset the server refuses anything
but localhost rather than silently exposing the dashboard. Visit
`/login?token=…` once to set a cookie.

## Deployment

One process. Any host that runs Node will do.

```sh
npm ci && npm run build
ADMIN_TOKEN=$(openssl rand -hex 32) npm start
```

Back up `data/autopilot.db` — it holds everything. The schema applies itself on
boot, so there is no migration step.

If you would rather run the sweeps from an external scheduler than the built-in
timers, set the intervals very high and hit the endpoints directly:

```
POST /api/sweeps/publish
POST /api/sweeps/metrics
POST /api/sweeps/plan
POST /api/sweeps/monitor
POST /api/sweeps/crawl
```

Two routes are public by necessity, since ordinary visitors on your customer's
site call them: `GET /t.js` serves the tracking snippet, and `POST /api/collect`
receives beacons. Everything else is behind `ADMIN_TOKEN`.

## Layout

```
src/
  config.ts            environment configuration, validated at boot
  db/                  schema + typed repository (node:sqlite)
  ai/
    client.ts          the single seam to the model; swapped for a stub in tests
    schemas.ts         Zod schemas enforced server-side via output_config.format
    brand.ts           five fields -> brand profile
    planner.ts         brand + performance -> dated calendar, with validation
  channels/
    types.ts           adapter interface and hard platform limits
    oauth1.ts          OAuth 1.0a signing (tested against X's published vector)
    email|x|linkedin|meta.ts
    simulate.ts        deterministic stand-in for an unconfigured channel
  web/
    url-guard.ts       SSRF protection: every outbound fetch is checked
    html.ts            title/meta/text/link extraction and robots.txt
    crawler.ts         polite same-origin crawl
    monitor.ts         health checks, TLS expiry, incident logic
    analytics.ts       visitor hashing, geo, device and referrer parsing
    tracker.ts         the snippet served to customer sites
    collect.ts         the public beacon endpoint's logic
  engine/
    publisher.ts       the publish sweep and its three gates
    metrics.ts         metric collection
    optimizer.ts       performance -> the next planning brief
    attribution.ts     UTM tagging of links to the business's own site
    stats.ts           marketing dashboard aggregation
    audience.ts        website health and audience aggregation
    scheduler.ts       five timers; the whole scheduler
  server/              HTTP, JSON API and the dashboard
tests/                 105 tests, node:test
```

## Tests

```sh
npm test
```

Covers the OAuth signature against a known vector, every content validation
rule, all three publish gates, retry versus permanent failure, attempt
exhaustion, double-claim prevention, cold-start behaviour, and the
repeated-polling cases that must not double-count metrics.

On the website side: the SSRF guard against every private address range
including cloud metadata, HTML and robots.txt parsing, that visitor hashes
never contain an IP and cannot be linked across days or across sites, bot
rejection, query-string stripping, bounce and session arithmetic, that internal
navigation is excluded from arrival sources, that a tracking key cannot write
visits for another site, and that link tagging never touches third-party URLs.

## Not built yet

Honest list of what this does not do:

- **No image or video generation**, which is why Instagram is inert and why
  Facebook and X posts are text-only.
- **The crawler does not run JavaScript.** A site that renders entirely
  client-side will read as nearly empty. Chromium is the fix, at real cost in
  memory and complexity.
- **Monitoring is from one location.** A regional outage that does not affect
  this server will not be seen.
- **No server-side goal validation.** A goal is a visit to a configured path.
  That is enough for a booking confirmation page, but it cannot see a purchase
  value or anything that happens in a payment processor.
- **No multi-user auth.** One shared admin token, no accounts or roles.
- **No A/B testing** of variants within a cycle.
- **No paid ads.** Organic channels only.
- **Email recipients** come from a Resend audience you manage; there is no list
  building or subscription handling here.
