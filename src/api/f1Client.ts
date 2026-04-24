// F1 Oracle v4.1 — F1 API Client
// Sources: Ergast API (historical), OpenF1 API (real-time), cached locally

import fetch from 'node-fetch';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import type {
  F1Race,
  ErgastRaceResult,
  ErgastQualifyingResult,
  ErgastStanding,
  Driver,
  Constructor,
} from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = resolve(__dirname, '../../cache');
mkdirSync(CACHE_DIR, { recursive: true });

const ERGAST_BASE = 'https://api.jolpi.ca/ergast/f1';  // community mirror (Ergast deprecated)
const OPENF1_BASE = 'https://api.openf1.org/v1';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ─── Cache helpers ────────────────────────────────────────────────────────────

function cacheGet<T>(key: string): T | null {
  const path = resolve(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const { ts, data } = JSON.parse(readFileSync(path, 'utf-8')) as { ts: number; data: T };
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}

function cacheSet<T>(key: string, data: T): void {
  const path = resolve(CACHE_DIR, `${key}.json`);
  writeFileSync(path, JSON.stringify({ ts: Date.now(), data }));
}

async function fetchJson<T>(url: string, cacheKey?: string, retries = 3): Promise<T> {
  if (cacheKey) {
    const cached = cacheGet<T>(cacheKey);
    if (cached) { logger.debug({ cacheKey }, 'Cache hit'); return cached; }
  }
  logger.debug({ url }, 'Fetching');

  for (let attempt = 1; attempt <= retries; attempt++) {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'F1Oracle/4.1 (+github)' },
      signal: AbortSignal.timeout(20000),
    });

    if (resp.status === 429) {
      // Rate limited — back off and retry
      const waitMs = attempt * 3000; // 3s, 6s, 9s
      logger.warn({ url, attempt, waitMs }, 'Rate limited (429) — backing off');
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const data = await resp.json() as T;
    if (cacheKey) cacheSet(cacheKey, data);
    return data;
  }

  throw new Error(`Failed after ${retries} retries: ${url}`);
}

// ─── 2026 F1 Season Driver Roster ─────────────────────────────────────────────

export const DRIVERS_2026: Driver[] = [
  // Red Bull
  { id: 'verstappen', name: 'Max Verstappen', shortName: 'VER', number: 1, constructorId: 'red_bull', nationality: 'Dutch', careerStarts: 200 },
  { id: 'lawson', name: 'Liam Lawson', shortName: 'LAW', number: 30, constructorId: 'red_bull', nationality: 'New Zealand', careerStarts: 20 },
  // Ferrari
  { id: 'leclerc', name: 'Charles Leclerc', shortName: 'LEC', number: 16, constructorId: 'ferrari', nationality: 'Monégasque', careerStarts: 140 },
  { id: 'hamilton', name: 'Lewis Hamilton', shortName: 'HAM', number: 44, constructorId: 'ferrari', nationality: 'British', careerStarts: 350 },
  // Mercedes
  { id: 'russell', name: 'George Russell', shortName: 'RUS', number: 63, constructorId: 'mercedes', nationality: 'British', careerStarts: 110 },
  { id: 'antonelli', name: 'Kimi Antonelli', shortName: 'ANT', number: 12, constructorId: 'mercedes', nationality: 'Italian', careerStarts: 5 },
  // McLaren
  { id: 'norris', name: 'Lando Norris', shortName: 'NOR', number: 4, constructorId: 'mclaren', nationality: 'British', careerStarts: 120 },
  { id: 'piastri', name: 'Oscar Piastri', shortName: 'PIA', number: 81, constructorId: 'mclaren', nationality: 'Australian', careerStarts: 60 },
  // Aston Martin
  { id: 'alonso', name: 'Fernando Alonso', shortName: 'ALO', number: 14, constructorId: 'aston_martin', nationality: 'Spanish', careerStarts: 380 },
  { id: 'stroll', name: 'Lance Stroll', shortName: 'STR', number: 18, constructorId: 'aston_martin', nationality: 'Canadian', careerStarts: 145 },
  // Alpine
  { id: 'gasly', name: 'Pierre Gasly', shortName: 'GAS', number: 10, constructorId: 'alpine', nationality: 'French', careerStarts: 130 },
  { id: 'doohan', name: 'Jack Doohan', shortName: 'DOO', number: 7, constructorId: 'alpine', nationality: 'Australian', careerStarts: 10 },
  // Williams
  { id: 'sainz', name: 'Carlos Sainz', shortName: 'SAI', number: 55, constructorId: 'williams', nationality: 'Spanish', careerStarts: 190 },
  { id: 'albon', name: 'Alexander Albon', shortName: 'ALB', number: 23, constructorId: 'williams', nationality: 'Thai', careerStarts: 95 },
  // Haas
  { id: 'ocon', name: 'Esteban Ocon', shortName: 'OCO', number: 31, constructorId: 'haas', nationality: 'French', careerStarts: 160 },
  { id: 'bearman', name: 'Oliver Bearman', shortName: 'BEA', number: 87, constructorId: 'haas', nationality: 'British', careerStarts: 15 },
  // Racing Bulls (VCARB)
  { id: 'tsunoda', name: 'Yuki Tsunoda', shortName: 'TSU', number: 22, constructorId: 'rb', nationality: 'Japanese', careerStarts: 100 },
  { id: 'hadjar', name: 'Isack Hadjar', shortName: 'HAD', number: 6, constructorId: 'rb', nationality: 'French', careerStarts: 5 },
  // Kick Sauber (future Audi)
  { id: 'hulkenberg', name: 'Nico Hülkenberg', shortName: 'HUL', number: 27, constructorId: 'sauber', nationality: 'German', careerStarts: 230 },
  { id: 'bortoleto', name: 'Gabriel Bortoleto', shortName: 'BOR', number: 5, constructorId: 'sauber', nationality: 'Brazilian', careerStarts: 5 },
];

export const CONSTRUCTORS_2026: Constructor[] = [
  { id: 'red_bull', name: 'Oracle Red Bull Racing', shortName: 'Red Bull', color: '#3671C6' },
  { id: 'ferrari', name: 'Scuderia Ferrari', shortName: 'Ferrari', color: '#E8002D' },
  { id: 'mercedes', name: 'Mercedes-AMG Petronas', shortName: 'Mercedes', color: '#27F4D2' },
  { id: 'mclaren', name: 'McLaren Formula 1', shortName: 'McLaren', color: '#FF8000' },
  { id: 'aston_martin', name: 'Aston Martin Aramco', shortName: 'Aston Martin', color: '#229971' },
  { id: 'alpine', name: 'BWT Alpine F1 Team', shortName: 'Alpine', color: '#FF87BC' },
  { id: 'williams', name: 'Williams Racing', shortName: 'Williams', color: '#64C4FF' },
  { id: 'haas', name: 'MoneyGram Haas F1 Team', shortName: 'Haas', color: '#B6BABD' },
  { id: 'rb', name: 'Visa Cash App Racing Bulls', shortName: 'Racing Bulls', color: '#6692FF' },
  { id: 'sauber', name: 'Stake F1 Team Kick Sauber', shortName: 'Sauber', color: '#52E252' },
];

// ─── Race Calendar ────────────────────────────────────────────────────────────

export async function getRaceCalendar(season: number): Promise<F1Race[]> {
  const cacheKey = `calendar_${season}`;
  const cached = cacheGet<F1Race[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<{ MRData: { RaceTable: { Races: Array<Record<string, unknown>> } } }>(
      `${ERGAST_BASE}/${season}.json?limit=30`,
    );
    const races = data.MRData.RaceTable.Races.map((r): F1Race => {
      const fp1 = r['FirstPractice'] as { date: string } | undefined;
      const fp2 = r['SecondPractice'] as { date: string } | undefined;
      const fp3 = r['ThirdPractice'] as { date: string } | undefined;
      const quali = r['Qualifying'] as { date: string } | undefined;
      const sprint = r['Sprint'] as { date: string } | undefined;
      const sprintQuali = r['SprintQualifying'] as { date: string } | undefined;
      const circuit = r['Circuit'] as { circuitId: string; circuitName: string };
      return {
        season: Number(r['season']),
        round: Number(r['round']),
        grandPrix: r['raceName'] as string,
        circuit: circuit.circuitName,
        circuitId: circuit.circuitId,
        country: (r['Circuit'] as { Location: { country: string } }).Location.country,
        date: r['date'] as string,
        fp1Date: fp1?.date ?? null,
        fp2Date: fp2?.date ?? null,
        fp3Date: fp3?.date ?? null,
        qualifyingDate: quali?.date ?? null,
        sprintDate: sprint?.date ?? null,
        sprintQualifyingDate: sprintQuali?.date ?? null,
        isSprintWeekend: !!sprint,
      };
    });
    cacheSet(cacheKey, races);
    return races;
  } catch (err) {
    logger.error({ err }, 'Failed to fetch race calendar');
    return [];
  }
}

export function getCurrentRaceRound(calendar: F1Race[]): F1Race | null {
  const today = new Date().toISOString().split('T')[0];
  // Find the next race that hasn't happened yet, or the most recent
  const upcoming = calendar.filter(r => r.date >= today);
  if (upcoming.length > 0) return upcoming[0];
  // Return last race of the season
  return calendar.length > 0 ? calendar[calendar.length - 1] : null;
}

export function isRaceWeekend(race: F1Race): boolean {
  const today = new Date().toISOString().split('T')[0];
  // Race weekend = from FP1 date to race date (inclusive)
  const start = race.fp1Date ?? race.qualifyingDate ?? race.date;
  return today >= start && today <= race.date;
}

// ─── Race Results ─────────────────────────────────────────────────────────────

export async function getRaceResult(season: number, round: number): Promise<ErgastRaceResult | null> {
  const cacheKey = `race_result_${season}_${round}`;
  const cached = cacheGet<ErgastRaceResult>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<{ MRData: { RaceTable: { Races: ErgastRaceResult[] } } }>(
      `${ERGAST_BASE}/${season}/${round}/results.json`,
    );
    const races = data.MRData.RaceTable.Races;
    if (!races || races.length === 0) return null;
    const race = normalizeRaceResult(races[0]);
    cacheSet(cacheKey, race);
    return race;
  } catch (err) {
    logger.error({ err, season, round }, 'Failed to fetch race result');
    return null;
  }
}

/** Normalize Ergast raw response: map Capital-C field names to lowercase to match type. */
function normalizeRaceResult(raw: unknown): ErgastRaceResult {
  const r = raw as Record<string, unknown>;
  // Ergast returns 'Circuit' (capital C); normalize to 'circuit'
  if (!r['circuit'] && r['Circuit']) r['circuit'] = r['Circuit'];
  // Normalize Results drivers/constructors
  const results = (r['Results'] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const result of results) {
    if (!result['Driver'] && result['driver']) result['Driver'] = result['driver'];
    if (!result['Constructor'] && result['constructor']) result['Constructor'] = result['constructor'];
    if (!result['FastestLap'] && result['fastestLap']) result['FastestLap'] = result['fastestLap'];
    if (!result['Time'] && result['time']) result['Time'] = result['time'];
  }
  return r as unknown as ErgastRaceResult;
}

export async function getQualifyingResult(season: number, round: number): Promise<ErgastQualifyingResult | null> {
  const cacheKey = `qualifying_${season}_${round}`;
  const cached = cacheGet<ErgastQualifyingResult>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<{ MRData: { RaceTable: { Races: ErgastQualifyingResult[] } } }>(
      `${ERGAST_BASE}/${season}/${round}/qualifying.json`,
    );
    const races = data.MRData.RaceTable.Races;
    if (!races || races.length === 0) return null;
    const race = normalizeQualifyingResult(races[0]);
    cacheSet(cacheKey, race);
    return race;
  } catch (err) {
    logger.error({ err, season, round }, 'Failed to fetch qualifying result');
    return null;
  }
}

function normalizeQualifyingResult(raw: unknown): ErgastQualifyingResult {
  const r = raw as Record<string, unknown>;
  if (!r['circuit'] && r['Circuit']) r['circuit'] = r['Circuit'];
  const results = (r['QualifyingResults'] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const result of results) {
    if (!result['Driver'] && result['driver']) result['Driver'] = result['driver'];
    if (!result['Constructor'] && result['constructor']) result['Constructor'] = result['constructor'];
    // Normalize Q time fields (sometimes lowercase in older Ergast data)
    if (!result['Q1'] && result['q1']) result['Q1'] = result['q1'];
    if (!result['Q2'] && result['q2']) result['Q2'] = result['q2'];
    if (!result['Q3'] && result['q3']) result['Q3'] = result['q3'];
  }
  return r as unknown as ErgastQualifyingResult;
}

export async function getRecentRaceResults(season: number, lastN: number = 5): Promise<ErgastRaceResult[]> {
  const cacheKey = `recent_races_${season}_${lastN}`;
  const cached = cacheGet<ErgastRaceResult[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<{ MRData: { RaceTable: { Races: ErgastRaceResult[] } } }>(
      `${ERGAST_BASE}/${season}/results.json?limit=100`,
    );
    const races = (data.MRData.RaceTable.Races ?? []).slice(-lastN).map(normalizeRaceResult);
    cacheSet(cacheKey, races);
    return races;
  } catch (err) {
    logger.error({ err, season }, 'Failed to fetch recent race results');
    return [];
  }
}

export async function getRecentQualifyingResults(season: number, lastN: number = 3): Promise<ErgastQualifyingResult[]> {
  const cacheKey = `recent_qualifying_${season}_${lastN}`;
  const cached = cacheGet<ErgastQualifyingResult[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<{ MRData: { RaceTable: { Races: ErgastQualifyingResult[] } } }>(
      `${ERGAST_BASE}/${season}/qualifying.json?limit=100`,
    );
    const races = (data.MRData.RaceTable.Races ?? []).slice(-lastN).map(normalizeQualifyingResult);
    cacheSet(cacheKey, races);
    return races;
  } catch (err) {
    logger.error({ err, season }, 'Failed to fetch recent qualifying results');
    return [];
  }
}

// ─── Prior season constructor standings ───────────────────────────────────────

export async function getConstructorStandings(season: number): Promise<ErgastStanding[]> {
  const cacheKey = `constructor_standings_${season}`;
  const cached = cacheGet<ErgastStanding[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<{
      MRData: { StandingsTable: { StandingsLists: Array<{ ConstructorStandings: ErgastStanding[] }> } };
    }>(`${ERGAST_BASE}/${season}/constructorStandings.json`);
    const lists = data.MRData.StandingsTable.StandingsLists;
    if (!lists || lists.length === 0) return [];
    const standings = lists[lists.length - 1].ConstructorStandings;
    cacheSet(cacheKey, standings);
    return standings;
  } catch (err) {
    logger.error({ err, season }, 'Failed to fetch constructor standings');
    return [];
  }
}

export async function getDriverStandings(season: number): Promise<ErgastStanding[]> {
  const cacheKey = `driver_standings_${season}`;
  const cached = cacheGet<ErgastStanding[]>(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchJson<{
      MRData: { StandingsTable: { StandingsLists: Array<{ DriverStandings: ErgastStanding[] }> } };
    }>(`${ERGAST_BASE}/${season}/driverStandings.json`);
    const lists = data.MRData.StandingsTable.StandingsLists;
    if (!lists || lists.length === 0) return [];
    const standings = lists[lists.length - 1].DriverStandings;
    cacheSet(cacheKey, standings);
    return standings;
  } catch (err) {
    logger.error({ err, season }, 'Failed to fetch driver standings');
    return [];
  }
}

// ─── Circuit-specific historical data ────────────────────────────────────────

export async function getCircuitHistory(
  circuitId: string,
  seasons: number[],
): Promise<ErgastRaceResult[]> {
  const results: ErgastRaceResult[] = [];
  for (const season of seasons) {
    const cacheKey = `circuit_history_${circuitId}_${season}`;
    const cached = cacheGet<ErgastRaceResult | null>(cacheKey);
    if (cached) { results.push(cached); continue; }

    try {
      const data = await fetchJson<{ MRData: { RaceTable: { Races: ErgastRaceResult[] } } }>(
        `${ERGAST_BASE}/${season}/circuits/${circuitId}/results.json`,
      );
      const race = data.MRData.RaceTable.Races?.[0];
      if (race) {
        results.push(race);
        cacheSet(cacheKey, race);
      }
    } catch { /* skip failed seasons */ }
  }
  return results;
}

// ─── OpenF1 session data ──────────────────────────────────────────────────────

export async function getOpenF1Sessions(season: number, circuitKey?: string): Promise<unknown[]> {
  const cacheKey = `openf1_sessions_${season}_${circuitKey ?? 'all'}`;
  const cached = cacheGet<unknown[]>(cacheKey);
  if (cached) return cached;

  try {
    const url = circuitKey
      ? `${OPENF1_BASE}/sessions?year=${season}&circuit_key=${circuitKey}`
      : `${OPENF1_BASE}/sessions?year=${season}`;
    const data = await fetchJson<unknown[]>(url);
    cacheSet(cacheKey, data);
    return data;
  } catch (err) {
    logger.warn({ err }, 'OpenF1 sessions unavailable');
    return [];
  }
}

// ─── Current season helpers ───────────────────────────────────────────────────

export function getCurrentF1Season(): number {
  return new Date().getFullYear();
}

export function isF1Season(): boolean {
  // F1 races roughly March–December
  const month = new Date().getMonth() + 1; // 1-indexed
  return month >= 3 && month <= 12;
}

// ─── Qualifying time parser ───────────────────────────────────────────────────

export function parseQualiTime(timeStr: string | undefined): number | null {
  if (!timeStr) return null;
  // Format: "1:18.765" or "1:18:765" or "78.765"
  const parts = timeStr.split(':');
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  const secs = Number(timeStr);
  return isNaN(secs) ? null : secs;
}
