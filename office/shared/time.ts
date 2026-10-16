export const defaultTimeZone = 'Europe/Istanbul';
const formatters = new Map<string, Intl.DateTimeFormat>();
const starts = new Map<string, number>();

export function officeDay(date: Date | string | number = Date.now(), timeZone = defaultTimeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone,formatter);
  }
  return formatter.format(new Date(date));
}

// Search for the first instant of a local calendar day, including DST changes.
export function dayStart(day: string, timeZone = defaultTimeZone) {
  const key = timeZone + ':' + day, cached = starts.get(key);
  if (cached !== undefined) return new Date(cached);
  const target = Date.parse(`${day}T00:00:00Z`);
  let low = target - 36 * 3600000, high = target + 36 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (officeDay(mid, timeZone) < day) low = mid;
    else high = mid;
  }
  if (starts.size >= 128) starts.clear();
  starts.set(key,high);
  return new Date(high);
}

export function previousDay(day: string, days = 1) {
  return new Date(Date.parse(`${day}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
}
