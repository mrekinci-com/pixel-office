export function storedNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw === null ? fallback : Number(raw);
    return Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback;
  } catch {
    return fallback;
  }
}

export function savePreference(key: string, value: string | number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Keep the preference for this session when storage is unavailable.
  }
}
