// F1 Oracle v4.1 — Driver Elo System
// Isolates individual driver skill from car performance via teammate comparison.
// Elo updates after each race using intra-team finishing order.
// K-factor: 10 (skill changes slowly; car effects dominate)

import { logger } from '../logger.js';
import { getAllDriverElo, upsertDriverElo } from '../db/database.js';
import { DRIVERS_2026 } from '../api/f1Client.js';
import type { DriverElo, ErgastRaceResult } from '../types.js';

const DEFAULT_ELO = 1500;
const ROOKIE_ELO = 1350;     // rookies start below average
const K_FACTOR = 10;

// ─── Base Elo seeds (2025 end-of-season estimates) ───────────────────────────

const SEEDED_ELO_2026: Record<string, number> = {
  // Top tier
  verstappen: 1720,
  norris: 1680,
  leclerc: 1650,
  piastri: 1620,
  hamilton: 1660,
  russell: 1600,
  // Second tier
  sainz: 1580,
  alonso: 1570,
  gasly: 1530,
  tsunoda: 1510,
  albon: 1500,
  hulkenberg: 1490,
  // Third tier
  ocon: 1470,
  stroll: 1430,
  // Rookies / limited starts
  antonelli: ROOKIE_ELO,
  lawson: 1420,
  bearman: 1380,
  doohan: ROOKIE_ELO,
  hadjar: ROOKIE_ELO,
  bortoleto: ROOKIE_ELO,
};

// ─── Initialize Elo for current season ───────────────────────────────────────

export async function initDriverElo(season: number): Promise<void> {
  const existing = getAllDriverElo();
  const existingIds = new Set(existing.map(e => e.driverId));

  for (const driver of DRIVERS_2026) {
    if (!existingIds.has(driver.id)) {
      const seedElo = SEEDED_ELO_2026[driver.id] ?? DEFAULT_ELO;
      upsertDriverElo({
        driverId: driver.id,
        driverName: driver.name,
        rating: seedElo,
        gamesPlayed: 0,
        season,
        updatedAt: new Date().toISOString(),
      });
      logger.debug({ driverId: driver.id, seedElo }, 'Seeded driver Elo');
    }
  }
}

// ─── Get current Elo for all drivers ─────────────────────────────────────────

export function getDriverEloMap(): Map<string, number> {
  const all = getAllDriverElo();
  const map = new Map<string, number>();

  // Start with seeds for any missing
  for (const driver of DRIVERS_2026) {
    map.set(driver.id, SEEDED_ELO_2026[driver.id] ?? DEFAULT_ELO);
  }

  // Override with stored values
  for (const elo of all) {
    map.set(elo.driverId, elo.rating);
  }

  return map;
}

// ─── Elo expected score ───────────────────────────────────────────────────────

function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// ─── Update Elo after a race ──────────────────────────────────────────────────

/**
 * Update driver Elo ratings after a race.
 * Uses intra-team comparison (teammate H2H) to isolate skill from car.
 * If both drivers finish, the one who finishes higher gains Elo.
 */
export function updateEloAfterRace(
  raceResult: ErgastRaceResult,
  season: number,
): Map<string, number> {
  const eloMap = getDriverEloMap();

  // Group by constructor for teammate comparisons
  const byConstructor: Map<string, Array<{ driverId: string; position: number; status: string }>> = new Map();

  for (const r of raceResult.Results ?? []) {
    const constructorId = r.Constructor.constructorId;
    const driverId = r.Driver.driverId;
    const position = Number(r.position);
    const status = r.status;

    if (!byConstructor.has(constructorId)) byConstructor.set(constructorId, []);
    byConstructor.get(constructorId)!.push({ driverId, position, status });
  }

  // Update Elo for each constructor pair
  for (const [constructorId, drivers] of byConstructor.entries()) {
    if (drivers.length < 2) continue;

    const [a, b] = drivers;
    const ratingA = eloMap.get(a.driverId) ?? DEFAULT_ELO;
    const ratingB = eloMap.get(b.driverId) ?? DEFAULT_ELO;

    // Only compare if at least one finished (exclude mechanical DNFs for both)
    const aFinished = a.status === 'Finished' || a.status.includes('+');
    const bFinished = b.status === 'Finished' || b.status.includes('+');

    if (!aFinished && !bFinished) {
      logger.debug({ constructorId }, 'Both DNF — skipping Elo update');
      continue;
    }

    // Determine winner
    let scoreA: number;
    if (aFinished && !bFinished) {
      scoreA = 1; // a finished, b didn't
    } else if (!aFinished && bFinished) {
      scoreA = 0; // b finished, a didn't
    } else {
      // Both finished — compare positions
      scoreA = a.position < b.position ? 1 : 0;
    }

    const expectedA = expectedScore(ratingA, ratingB);
    const delta = K_FACTOR * (scoreA - expectedA);

    const newRatingA = Math.round((ratingA + delta) * 10) / 10;
    const newRatingB = Math.round((ratingB - delta) * 10) / 10;

    eloMap.set(a.driverId, newRatingA);
    eloMap.set(b.driverId, newRatingB);

    logger.debug(
      { constructorId, driverA: a.driverId, newA: newRatingA, driverB: b.driverId, newB: newRatingB },
      'Elo updated',
    );
  }

  // Persist to DB
  const now = new Date().toISOString();
  const allDrivers = getAllDriverElo();
  const dbMap = new Map(allDrivers.map(e => [e.driverId, e]));

  for (const [driverId, rating] of eloMap.entries()) {
    const existing = dbMap.get(driverId);
    upsertDriverElo({
      driverId,
      driverName: existing?.driverName ?? driverId,
      rating,
      gamesPlayed: (existing?.gamesPlayed ?? 0) + 1,
      season,
      updatedAt: now,
    });
  }

  return eloMap;
}

// ─── Driver skill delta from Elo ─────────────────────────────────────────────

/**
 * Convert Elo rating to a pace delta in seconds/lap relative to average driver.
 * This is applied on top of the constructor pace delta.
 * Scale: 100 Elo points ≈ 0.05s/lap difference.
 */
export function eloToPaceDelta(elo: number): number {
  const avgElo = 1500;
  const eloRange = 400;    // typical spread
  const paceRange = 0.20;  // 0.20s/lap difference for full Elo range
  return -((elo - avgElo) / eloRange) * paceRange; // negative = faster (lower time)
}

// ─── Teammate delta from qualifying ──────────────────────────────────────────

/**
 * Compute qualifying gap between teammates (isolates driver quality).
 * Returns gap in seconds (negative = driverA is faster).
 */
export function computeTeammateDelta(
  qualiResults: Array<{ driverId: string; qualiTimeS: number | null }>,
  driverIdA: string,
  driverIdB: string,
): number {
  const a = qualiResults.find(q => q.driverId === driverIdA)?.qualiTimeS;
  const b = qualiResults.find(q => q.driverId === driverIdB)?.qualiTimeS;
  if (a === null || b === null || a === undefined || b === undefined) return 0;
  return a - b; // negative if A is faster
}

// ─── H2H probability from Elo ─────────────────────────────────────────────────

/**
 * Probability that driverA beats driverB (any comparison, not just same team).
 */
export function h2hProbability(eloA: number, eloB: number): number {
  return expectedScore(eloA, eloB);
}

// ─── Elo display helpers ──────────────────────────────────────────────────────

export function eloTier(elo: number): string {
  if (elo >= 1700) return 'Elite';
  if (elo >= 1620) return 'Top';
  if (elo >= 1540) return 'Strong';
  if (elo >= 1460) return 'Average';
  if (elo >= 1380) return 'Below Avg';
  return 'Developing';
}
