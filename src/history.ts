export const DAY = 86_400_000;
const WINDOW = 14 * DAY;
const RETENTION = 90 * DAY;
const COOLDOWN = 15_000;
const NOTE_LIMIT = 300;
const EVENT_LIMIT = 4_000;

export interface Visit {
  path: string;
  last: number;
  opens: number[];
}

function validTime(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > min && value <= max;
}

export function normalizeHistory(value: unknown, now: number): Visit[] {
  if (!Array.isArray(value)) return [];
  const records = new Map<string, Visit>();
  for (const entry of value) {
    if (!entry || typeof entry.path !== "string" || !entry.path.toLowerCase().endsWith(".md") ||
        !validTime(entry.last, now - RETENTION, now) || !Array.isArray(entry.opens)) continue;
    const previous = records.get(entry.path);
    const opens = entry.opens.filter((time: unknown) => validTime(time, now - WINDOW, entry.last));
    records.set(entry.path, {
      path: entry.path, last: Math.max(entry.last, previous?.last ?? 0),
      opens: [...(previous?.opens ?? []), ...opens]
    });
  }
  const visits = [...records.values()].sort((a, b) => b.last - a.last).slice(0, NOTE_LIMIT);
  const cutoff = visits.flatMap(v => v.opens).sort((a, b) => b - a)[EVENT_LIMIT - 1] ?? 0;
  let remaining = EVENT_LIMIT;
  for (const visit of visits) {
    visit.opens = remaining > 0
      ? [...new Set(visit.opens)].filter(t => t >= cutoff).sort((a, b) => a - b).slice(-remaining)
      : [];
    remaining -= visit.opens.length;
  }
  return visits;
}

export function addVisit(visits: Visit[], path: string, now: number, repeated: boolean): Visit[] {
  const previous = visits.find(v => v.path === path);
  if (previous && repeated && now - previous.last < COOLDOWN) return visits;
  const opens = previous?.opens ?? [];
  const latest = opens.at(-1);
  const next = latest === undefined || now - latest >= COOLDOWN ? [...opens, now] : opens;
  return normalizeHistory([...visits.filter(v => v.path !== path), { path, last: now, opens: next }], now);
}

export function rankVisits(visits: Visit[], mode: "recent" | "frequent", now: number, limit = 8): Visit[] {
  const ranked = normalizeHistory(visits, now);
  if (mode === "recent") return ranked.slice(0, limit);
  return ranked.map(visit => ({
    visit,
    score: visit.opens.reduce((sum, time) => sum + 2 ** (-(now - time) / (5 * DAY)), 0)
  })).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || b.visit.last - a.visit.last)
    .slice(0, limit).map(row => row.visit);
}

export function remapHistory(visits: Visit[], oldPath: string, newPath: string | null, now: number): Visit[] {
  return normalizeHistory(visits.flatMap(v => {
    if (v.path !== oldPath && !v.path.startsWith(oldPath + "/")) return [v];
    return newPath ? [{ ...v, path: newPath + v.path.slice(oldPath.length) }] : [];
  }), now);
}
