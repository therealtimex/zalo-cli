export function normalizeTimestamp(value) {
    if (value === null || value === undefined || value === "") return null;

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;

    // Zalo payloads may expose seconds, milliseconds, or occasionally microseconds.
    if (parsed < 1_000_000_000_000) return Math.trunc(parsed * 1000);
    if (parsed > 100_000_000_000_000) return Math.trunc(parsed / 1000);
    return Math.trunc(parsed);
}

export function timestampOrNow(value) {
    return normalizeTimestamp(value) ?? Date.now();
}
