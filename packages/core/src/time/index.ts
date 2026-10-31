import * as chrono from 'chrono-node';
import type { ReminderTimeParser } from '../contracts.ts';

const TRIGGER = /^\s*(?:remind\s+me|\/remind(?:@\w+)?)(?![\p{L}\p{N}_])/iu;
const LEADING_FILLER = /^[\s,:;-]*(?:(?:to|about|that|of)\s+)?/i;
const DANGLING_PREPOSITION = /(?:\s+(?:on|at|in|by|for|around|from|before|after|this|next))+\s*$/i;
/** Durations such as "in 2 hours" count elapsed time, so DST must not shift them. */
const ELAPSED_DURATION = /^(?:in|within)?\s*(?:\d+|an?|half an?|a couple of|few)?\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i;

function createFormatter(timezone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return null;
  }
}

/** Offset of `timezone` from UTC in milliseconds at the given instant. */
function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const parts = formatter.formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(instant / 1000) * 1000;
}

/** Converts a wall-clock time (as UTC fields) in the zone to the real instant. */
function wallToInstant(formatter: Intl.DateTimeFormat, wall: number): number {
  let instant = wall - offsetAt(formatter, wall);
  instant = wall - offsetAt(formatter, instant);
  return wall - offsetAt(formatter, instant);
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(DANGLING_PREPOSITION, '')
    .replace(LEADING_FILLER, '')
    .replace(/[\s,;:-]+$/, '')
    .trim();
}

/**
 * Parses a reminder request such as "remind me to call mom tomorrow at 5pm".
 * Only messages starting with `remind me` or `/remind` are reminders. Times
 * are read in `context.timezone` (an IANA zone), never the machine's zone.
 */
export const parseReminderTime: ReminderTimeParser = (input, context) => {
  const trigger = TRIGGER.exec(input);
  if (!trigger) return null;

  const nowMs = context.now.getTime();
  const formatter = createFormatter(context.timezone);
  if (Number.isNaN(nowMs) || !formatter) return null;

  // chrono only understands fixed offsets, so it works on the wall clock of the
  // zone, expressed as UTC fields, and the result is converted back below.
  const wallNow = new Date(nowMs + offsetAt(formatter, nowMs));
  const rest = input.slice(trigger[0].length);
  const match = chrono.parse(rest, { instant: wallNow, timezone: 0 }, { forwardDate: true })[0];
  if (!match) return null;

  let remindAtMs: number;
  if (match.start.isCertain('timezoneOffset')) {
    // The message names its own offset (for example "5pm EST"): wall time is meaningless here.
    remindAtMs = chrono.parseDate(match.text, { instant: context.now, timezone: 0 }, { forwardDate: true })?.getTime() ?? NaN;
  } else if (ELAPSED_DURATION.test(match.text)) {
    remindAtMs = chrono.parseDate(match.text, { instant: context.now, timezone: 0 })?.getTime() ?? NaN;
  } else {
    remindAtMs = wallToInstant(formatter, match.start.date().getTime());
  }
  if (Number.isNaN(remindAtMs) || remindAtMs <= nowMs) return null;

  const before = rest.slice(0, match.index);
  const after = rest.slice(match.index + match.text.length);
  const text = tidy(`${tidy(before)} ${after}`);
  if (text === '') return null;

  return { remindAt: new Date(remindAtMs), text };
};
