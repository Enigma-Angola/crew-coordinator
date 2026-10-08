/** Offset (minutes) of a time zone from UTC at a given instant. */
export function tzOffsetMinutes(timeZone: string, at: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** Converts a local wall-clock date/time in a time zone to a UTC instant. */
export function zonedToUtc(date: string, time: string, timeZone: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const offset = tzOffsetMinutes(timeZone, guess);
  const first = new Date(guess.getTime() - offset * 60000);
  const offset2 = tzOffsetMinutes(timeZone, first);
  return offset2 === offset ? first : new Date(guess.getTime() - offset2 * 60000);
}

/** Local date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at: Date | string, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

export function localTime(at: Date | string, timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(date: string, n: number) {
  const x = new Date(`${date}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return isoDate(x);
}
