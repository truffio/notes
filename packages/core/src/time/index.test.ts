import { describe, expect, it } from 'vitest';
import { parseReminderTime } from './index.ts';

const now = new Date('2026-03-01T15:00:00Z'); // 10:00 in Toronto (EST), day before DST starts

function parse(input: string, timezone = 'America/Toronto', at = now) {
  return parseReminderTime(input, { now: at, timezone });
}

describe('parseReminderTime triggers', () => {
  it('accepts "remind me" case-insensitively and /remind', () => {
    expect(parse('Remind me to call mom tomorrow at 5pm')?.text).toBe('call mom');
    expect(parse('REMIND ME to call mom tomorrow at 5pm')?.text).toBe('call mom');
    expect(parse('/remind call mom tomorrow at 5pm')?.text).toBe('call mom');
  });

  it('returns null for ordinary notes mentioning dates', () => {
    expect(parse('Dentist appointment tomorrow at 5pm')).toBeNull();
    expect(parse('Please remind me tomorrow at 5pm to call')).toBeNull();
    expect(parse('reminders for tomorrow at 5pm')).toBeNull();
    expect(parse('/reminder tomorrow at 5pm call mom')).toBeNull();
  });

  it('returns null for unclear or past times', () => {
    expect(parse('remind me to buy milk')).toBeNull();
    expect(parse('remind me to call yesterday at 5pm')).toBeNull();
    expect(parse('remind me tomorrow at 5pm')).toBeNull();
    expect(parse('remind me to call mom tomorrow', 'Not/AZone')).toBeNull();
  });
});

describe('parseReminderTime text', () => {
  it('removes the time phrase wherever it sits', () => {
    expect(parse('remind me tomorrow at 5pm to call mom')?.text).toBe('call mom');
    expect(parse('remind me to call mom at 5pm tomorrow')?.text).toBe('call mom');
    expect(parse('remind me to pay rent on March 5 at 9am')?.text).toBe('pay rent');
  });
});

describe('parseReminderTime timezones', () => {
  it('interprets times in the context timezone, not the machine zone', () => {
    const toronto = parse('remind me to call mom tomorrow at 5pm', 'America/Toronto');
    const tokyo = parse('remind me to call mom tomorrow at 5pm', 'Asia/Tokyo');
    const utc = parse('remind me to call mom tomorrow at 5pm', 'UTC');
    expect(toronto?.remindAt.toISOString()).toBe('2026-03-02T22:00:00.000Z');
    expect(tokyo?.remindAt.toISOString()).toBe('2026-03-03T08:00:00.000Z');
    expect(utc?.remindAt.toISOString()).toBe('2026-03-02T17:00:00.000Z');
  });

  it('uses the zone for the local calendar day', () => {
    // 03:00 UTC on Mar 2 is still Mar 1 evening in Toronto, already Mar 2 in Tokyo.
    const late = new Date('2026-03-02T03:00:00Z');
    expect(parse('remind me to x tomorrow at 9am', 'America/Toronto', late)?.remindAt.toISOString()).toBe(
      '2026-03-02T14:00:00.000Z',
    );
    expect(parse('remind me to x tomorrow at 9am', 'Asia/Tokyo', late)?.remindAt.toISOString()).toBe(
      '2026-03-03T00:00:00.000Z',
    );
  });

  it('keeps local wall-clock time across the spring DST change', () => {
    // Toronto switches to EDT on 2026-03-08. Before: UTC-5, after: UTC-4.
    expect(parse('remind me to x on March 7 at 9am')?.remindAt.toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(parse('remind me to x on March 9 at 9am')?.remindAt.toISOString()).toBe('2026-03-09T13:00:00.000Z');
    // "tomorrow" from the evening before the change.
    const eve = new Date('2026-03-08T03:00:00Z'); // 22:00 on Mar 7 in Toronto
    expect(parse('remind me to x tomorrow at 9am', 'America/Toronto', eve)?.remindAt.toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
  });

  it('keeps local wall-clock time across the autumn DST change', () => {
    const fall = new Date('2026-10-30T12:00:00Z');
    // Toronto returns to EST on 2026-11-01.
    expect(parse('remind me to x on Oct 31 at 9am', 'America/Toronto', fall)?.remindAt.toISOString()).toBe(
      '2026-10-31T13:00:00.000Z',
    );
    expect(parse('remind me to x on Nov 2 at 9am', 'America/Toronto', fall)?.remindAt.toISOString()).toBe(
      '2026-11-02T14:00:00.000Z',
    );
  });

  it('honors an explicit offset in the message', () => {
    expect(parse('remind me to x tomorrow at 5pm UTC', 'Asia/Tokyo')?.remindAt.toISOString()).toBe(
      '2026-03-02T17:00:00.000Z',
    );
  });

  it('counts elapsed time for durations across a DST change', () => {
    const before = new Date('2026-03-08T05:30:00Z'); // 00:30 EST
    expect(parse('remind me to x in 2 hours', 'America/Toronto', before)?.remindAt.toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });
});
