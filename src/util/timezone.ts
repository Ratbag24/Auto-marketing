/**
 * Timezone conversion for scheduling.
 *
 * The planner thinks in the business's local time, because "post at 9am" only
 * means anything locally. Everything is stored in UTC. These helpers are the
 * only place that conversion happens.
 *
 * No dependency: Intl has the full IANA database built in, and using it keeps
 * the zone rules current with the Node runtime rather than a pinned package.
 */

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Falls back to UTC rather than throwing, so bad data can never stop a sweep. */
export function safeTimeZone(tz: string | null | undefined): string {
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

/**
 * How far the zone is ahead of UTC at a given instant, in milliseconds.
 * Positive east of Greenwich. Accounts for daylight saving automatically.
 */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23", // without this some runtimes report hour 24
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, number> = {};
  for (const part of dtf.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }

  // Read the zone's wall clock back as though it were UTC; the difference from
  // the real instant is the offset.
  const asIfUtc = Date.UTC(
    parts["year"] ?? 1970,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );

  return asIfUtc - at.getTime();
}

/** The local wall-clock hour of a UTC instant, 0-23. */
export function localHour(iso: string, timeZone: string): number {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 0;
  const shifted = new Date(at.getTime() + zoneOffsetMs(at, safeTimeZone(timeZone)));
  return shifted.getUTCHours();
}

/**
 * Turns a wall-clock time in a zone into the UTC instant it refers to.
 *
 * The offset depends on the instant, and the instant is what we are solving
 * for, so this guesses once and corrects - which is what makes it right across
 * daylight-saving boundaries.
 *
 * Two edge cases are inherent to wall-clock time, not bugs here: an hour
 * skipped by a spring-forward does not exist (the result lands just after the
 * jump), and an hour repeated by a fall-back is ambiguous (the earlier of the
 * two is chosen). Both are off by at most an hour, once a year.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const zone = safeTimeZone(timeZone);
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const firstGuess = wall - zoneOffsetMs(new Date(wall), zone);
  // The offset at the guessed instant may differ from the offset at the wall
  // time - that is exactly what happens around a DST change.
  const corrected = wall - zoneOffsetMs(new Date(firstGuess), zone);

  return new Date(corrected);
}

/**
 * The UTC instant for "N days from `from`, at `hour` local time" in a zone.
 * This is what the scheduler needs from a planned item.
 */
export function scheduleAt(
  from: Date,
  dayOffset: number,
  hour: number,
  timeZone: string,
): Date {
  const zone = safeTimeZone(timeZone);

  // Work out the local calendar date `dayOffset` days after `from`.
  const localNow = new Date(from.getTime() + zoneOffsetMs(from, zone));
  localNow.setUTCDate(localNow.getUTCDate() + dayOffset);

  return zonedWallClockToUtc(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth() + 1,
    localNow.getUTCDate(),
    hour,
    0,
    zone,
  );
}
