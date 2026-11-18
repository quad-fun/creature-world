// The world outside the town: weather and the calendar. Everything here is DATA reduced to a tiny whitelist
// (7 weather conditions, 4 seasons, a few holiday labels that live in THIS file). The optional live weather
// reading is used only as three numbers (code, temperature, wind); no text from the network is ever kept,
// stored or shown. Without WEATHER_URL the weather is a deterministic seeded fake, so tests and offline runs work.
import { addInfluence, bumpNeed, appraise, impulse, relieve } from "./affect";
import { noteExposure, novelty, payoffScale } from "./novelty";
import type { Kv } from "./store";
import type { Outside, Season, Weather, World } from "./types";

export const WEATHERS: Weather[] = ["clear", "rain", "snow", "wind", "hot", "cold", "fog"];
export const isWeather = (x: unknown): x is Weather => typeof x === "string" && (WEATHERS as string[]).includes(x);
const SEASONS: Season[] = ["spring", "summer", "autumn", "winter"];
const isSeason = (x: unknown): x is Season => typeof x === "string" && (SEASONS as string[]).includes(x);

export const WEATHER_CACHE_S = 3600; // a live reading is reused for an hour
export const WEATHER_FAIL_S = 600; // after a failure, do not try again for ten minutes
export const WEATHER_TIMEOUT_MS = 3000;
const MAX_BODY = 20_000;
const CACHE_KEY = "outside:weather";
const FAIL_KEY = "outside:fail";

const WEATHER_WORD: Record<Weather, string> = { clear: "clear skies", rain: "rain", snow: "snow", wind: "a strong wind", hot: "hot", cold: "cold", fog: "fog" };

// ---------- calendar ----------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const isDateKey = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
export const dateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function seasonOf(date: string, lat = 1): Season {
  const m = Number(date.slice(5, 7));
  const north: Season = m >= 3 && m <= 5 ? "spring" : m >= 6 && m <= 8 ? "summer" : m >= 9 && m <= 11 ? "autumn" : "winter";
  if (lat >= 0) return north;
  return ({ spring: "autumn", summer: "winter", autumn: "spring", winter: "summer" } as const)[north];
}

/** A few holidays by month-day. Labels are fixed constants, never read from outside. */
const HOLIDAYS: { from: string; to: string; label: string }[] = [
  { from: "01-01", to: "01-01", label: "New Year's Day" },
  { from: "03-20", to: "03-20", label: "Spring Day" },
  { from: "06-21", to: "06-21", label: "Midsummer" },
  { from: "09-22", to: "09-22", label: "Harvest Day" },
  { from: "10-31", to: "10-31", label: "Lantern Night" },
  { from: "12-21", to: "12-21", label: "Midwinter" },
  { from: "12-24", to: "12-26", label: "the Winter Festival" },
];
export function holidayOf(date: string): string | null {
  const md = date.slice(5);
  return HOLIDAYS.find((h) => md >= h.from && md <= h.to)?.label ?? null;
}

// ---------- seeded fake weather ----------

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}

const SEASON_ODDS: Record<Season, [Weather, number][]> = {
  spring: [["clear", 0.34], ["rain", 0.3], ["wind", 0.16], ["fog", 0.1], ["cold", 0.1]],
  summer: [["clear", 0.42], ["hot", 0.24], ["rain", 0.16], ["wind", 0.08], ["fog", 0.1]],
  autumn: [["clear", 0.25], ["rain", 0.3], ["wind", 0.2], ["fog", 0.15], ["cold", 0.1]],
  winter: [["clear", 0.22], ["cold", 0.3], ["snow", 0.22], ["fog", 0.12], ["wind", 0.08], ["rain", 0.06]],
};

/** Same date and block always give the same weather. `block` lets one real day change a few times. */
export function seededWeather(date: string, block = 0, lat = 1): Weather {
  const odds = SEASON_ODDS[seasonOf(date, lat)];
  let r = (hash(`${date}#${block}`) % 10000) / 10000;
  for (const [wx, p] of odds) {
    if (r < p) return wx;
    r -= p;
  }
  return "clear";
}

// ---------- optional live reading (keyless public API, numbers only) ----------

/** Map a numeric reading (WMO weather code, degrees C, km/h) to the whitelist. Anything non-numeric gives null. */
export function weatherFromReading(code: unknown, tempC: unknown, windKmh: unknown): Weather | null {
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const c = n(code);
  const t = n(tempC);
  const wind = n(windKmh);
  if (c === null && t === null && wind === null) return null;
  if (c !== null) {
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
    if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95) return "rain";
    if (c === 45 || c === 48) return "fog";
  }
  if (t !== null && t >= 30) return "hot";
  if (t !== null && t <= 0) return "cold";
  if (wind !== null && wind >= 35) return "wind";
  return "clear";
}

export interface WeatherConfig {
  url: string;
  lat: number;
  lon: number;
}
/** Live weather is off unless WEATHER_URL is an https URL and WEATHER_LAT / WEATHER_LON are valid coordinates. */
export function weatherConfig(env: Record<string, string | undefined> = process.env): WeatherConfig | null {
  const url = env.WEATHER_URL?.trim();
  const lat = Number(env.WEATHER_LAT);
  const lon = Number(env.WEATHER_LON);
  if (!url || !env.WEATHER_LAT || !env.WEATHER_LON || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  try {
    if (new URL(url).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { url, lat, lon };
}

/** One bounded GET (3 s timeout, 20 KB cap). Returns a whitelisted condition or null; never throws. */
export async function fetchWeather(cfg: WeatherConfig, fetchImpl: typeof fetch = fetch): Promise<Weather | null> {
  try {
    const u = new URL(cfg.url);
    u.searchParams.set("latitude", String(cfg.lat));
    u.searchParams.set("longitude", String(cfg.lon));
    u.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m");
    u.searchParams.set("wind_speed_unit", "kmh");
    const res = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_BODY) return null;
    const cur = (JSON.parse(text) as { current?: Record<string, unknown> } | null)?.current;
    if (!cur || typeof cur !== "object") return null;
    return weatherFromReading(cur.weather_code, cur.temperature_2m, cur.wind_speed_10m);
  } catch {
    return null;
  }
}

function parseCache(raw: string | null, now: number): Weather | null {
  if (!raw) return null;
  const [ts, wx] = raw.split("|");
  const t = Number(ts);
  return Number.isFinite(t) && now - t >= 0 && now - t < WEATHER_CACHE_S * 1000 && isWeather(wx) ? wx : null;
}

/**
 * Called by the engine under the world lock, before stepping. Sets w.outside from the real date: the live weather
 * when configured and reachable (cached for an hour in the store), otherwise the seeded fake. Never throws.
 */
export async function refreshOutside(w: World, kv: Kv, now = Date.now(), fetchImpl: typeof fetch = fetch, env: Record<string, string | undefined> = process.env): Promise<void> {
  try {
    const cfg = weatherConfig(env);
    const lat = cfg?.lat ?? 1;
    const date = dateKey(now);
    const block = Math.floor(new Date(now).getUTCHours() / 6);
    let live: Weather | null = null;
    if (cfg) {
      try {
        live = parseCache(await kv.get(CACHE_KEY), now);
        if (!live) {
          const failedAt = Number((await kv.get(FAIL_KEY)) ?? 0);
          if (!(Number.isFinite(failedAt) && now - failedAt >= 0 && now - failedAt < WEATHER_FAIL_S * 1000)) {
            live = await fetchWeather(cfg, fetchImpl);
            if (live) await kv.set(CACHE_KEY, `${now}|${live}`);
            else await kv.set(FAIL_KEY, String(now));
          }
        }
      } catch {
        live = null; // store trouble: fall back silently
      }
    }
    w.outside = { date, weather: live ?? seededWeather(date, block, lat), season: seasonOf(date, lat), holiday: holidayOf(date), source: live ? "live" : "seeded", by: "engine", appliedDay: w.outside?.appliedDay ?? 0 };
  } catch {
    /* keep whatever was there */
  }
}

/** Deterministic outside for sims and worlds the engine has not touched: day 1 is 2026-01-01, one date per world day. */
export function worldOutside(w: World, day: number, appliedDay = 0): Outside {
  const date = dateKey(Date.UTC(2026, 0, 1) + (day - 1) * 86_400_000);
  return { date, weather: seededWeather(date, 0), season: seasonOf(date), holiday: holidayOf(date), source: "seeded", by: "world", appliedDay };
}

/** True when a stored value has exactly the shape we write (old or tampered data fails and is dropped on load). */
export function validOutside(o: unknown): o is Outside {
  const x = o as Outside;
  return !!x && typeof x === "object" && isDateKey(x.date) && isWeather(x.weather) && isSeason(x.season) && (x.holiday === null || (typeof x.holiday === "string" && HOLIDAYS.some((h) => h.label === x.holiday))) && (x.source === "seeded" || x.source === "live") && (x.by === "world" || x.by === "engine") && Number.isFinite(x.appliedDay);
}

/** The one labelled line shown in the town view and in prompts. Built only from whitelisted words. */
export function outsideLine(o: Outside | undefined): string {
  if (!o || !validOutside(o)) return "";
  return `Outside: ${WEATHER_WORD[o.weather]}, ${o.season}${o.holiday ? `, ${o.holiday}` : ""}`;
}

// ---------- small nudges, once per world day ----------

const INDOORS = ["nests", "workshop", "bakery"];

/**
 * Called by stepWorld when a new world day begins. Slight nudges through the existing influences, scaled by novelty
 * (the same weather again and again pays less). Nothing here can exceed a few hundredths of mood.
 */
export function applyOutside(w: World, day: number): void {
  let o = w.outside;
  if (!o || !validOutside(o) || o.by === "world") o = w.outside = worldOutside(w, day, o && validOutside(o) ? o.appliedDay : 0);
  if (o.appliedDay >= day) return;
  o.appliedDay = day;
  for (const c of Object.values(w.creatures)) {
    const out = !INDOORS.includes(c.place);
    const key = `weather:${o.weather}`;
    const pm = payoffScale(novelty(c, key, w.t));
    noteExposure(c, key, w.t);
    switch (o.weather) {
      case "clear":
        if (out) addInfluence(c, "joy", "a clear day", 0.14 * pm);
        break;
      case "rain":
        if (out) bumpNeed(c, "comfort", 0.05);
        impulse(c, appraise(c, ["rain"]) * 0.15 * pm);
        break;
      case "snow":
        if (out) {
          addInfluence(c, "joy", "snow", 0.2 * pm);
          bumpNeed(c, "comfort", 0.04);
        }
        break;
      case "wind":
        relieve(c, "boredom", 0.05 * pm);
        if (out) bumpNeed(c, "comfort", 0.03);
        break;
      case "hot":
        if (out && c.place !== "pond") bumpNeed(c, "comfort", 0.06);
        impulse(c, 0, -0.02);
        break;
      case "cold":
        if (out) bumpNeed(c, "comfort", 0.06);
        break;
      case "fog":
        if (c.place === "pond") addInfluence(c, "joy", "fog on the water", 0.1 * pm);
        break;
    }
    if (o.holiday) {
      relieve(c, "loneliness", 0.08);
      if (c.place === "fountain") addInfluence(c, "joy", o.holiday, 0.25);
    }
  }
}
