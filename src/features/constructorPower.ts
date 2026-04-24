// F1 Oracle v4.1 — Constructor Power Model
// THE most important model component. The car is ~80% of performance in F1.
// Estimates each constructor's pace relative to the fastest car in seconds/lap.

import { logger } from '../logger.js';
import { parseQualiTime } from '../api/f1Client.js';
import type {
  ConstructorPaceDelta,
  ErgastRaceResult,
  ErgastQualifyingResult,
  RaceContext,
} from '../types.js';

// ─── Prior-season baseline (end of 2025 season estimates) ─────────────────────
// Pace delta = seconds per lap behind the benchmark (fastest car = 0.000)
// Updated manually after each season / preseason testing

const PRIOR_SEASON_DELTAS: Record<string, number> = {
  mclaren: 0.000,      // 2025 constructor champion
  ferrari: 0.080,
  red_bull: 0.150,
  mercedes: 0.200,
  williams: 0.450,
  aston_martin: 0.480,
  alpine: 0.600,
  rb: 0.650,
  haas: 0.680,
  sauber: 0.800,
};

// Reliability rates (probability of finishing mechanical DNF = 1 - this value)
const PRIOR_RELIABILITY: Record<string, number> = {
  red_bull: 0.92,
  ferrari: 0.91,
  mercedes: 0.94,
  mclaren: 0.95,
  aston_martin: 0.93,
  alpine: 0.90,
  williams: 0.91,
  haas: 0.89,
  rb: 0.90,
  sauber: 0.88,
};

// Average pit stop times (seconds)
const PIT_STOP_AVGS: Record<string, number> = {
  red_bull: 2.4,
  ferrari: 2.5,
  mercedes: 2.5,
  mclaren: 2.4,
  aston_martin: 2.6,
  alpine: 2.7,
  williams: 2.6,
  haas: 2.8,
  rb: 2.7,
  sauber: 2.8,
};

// Circuit-specific adjustments (positive = car is slower than average here, negative = faster)
// Based on circuit characteristics (power vs downforce)
const CIRCUIT_ADJUSTMENTS: Record<string, Record<string, number>> = {
  monza: {       // power circuit — low-drag cars faster
    red_bull: -0.050, ferrari: -0.030, mercedes: -0.040,
    mclaren: 0.020, williams: -0.060, sauber: 0.030,
    aston_martin: 0.040, alpine: 0.020, rb: 0.010, haas: 0.020,
  },
  monaco: {      // street circuit — high downforce, tight, overtaking-free
    red_bull: -0.080, ferrari: -0.060, mercedes: 0.050,
    mclaren: 0.040, williams: 0.100, aston_martin: -0.020,
    alpine: 0.030, rb: 0.020, haas: 0.050, sauber: 0.060,
  },
  mexico: {      // high altitude — PU power matters more, less downforce
    red_bull: -0.040, ferrari: -0.020, mercedes: -0.030,
    mclaren: 0.010, williams: -0.030, aston_martin: 0.030,
    alpine: 0.020, rb: 0.010, haas: 0.030, sauber: 0.040,
  },
  silverstone: { // high-speed, high downforce
    red_bull: 0.020, ferrari: -0.040, mercedes: -0.060,
    mclaren: -0.050, williams: 0.040, aston_martin: -0.030,
    alpine: 0.020, rb: 0.010, haas: 0.030, sauber: 0.040,
  },
};

// ─── Qualifying gap → pace delta ──────────────────────────────────────────────

/**
 * Compute constructor pace deltas from qualifying session times.
 * Groups by constructor, takes best Q3/Q2/Q1 lap, computes gap to fastest.
 */
export function computeQualiPaceDeltas(
  qualiResults: ErgastQualifyingResult[],
  lastN: number = 3,
): Record<string, number> {
  // Use the last N qualifying sessions
  const sessions = qualiResults.slice(-lastN);
  const constructorGaps: Record<string, number[]> = {};

  for (const session of sessions) {
    // Find the fastest lap in this session
    const lapTimes: Array<{ constructorId: string; timeS: number }> = [];

    for (const qr of session.QualifyingResults) {
      const constructorId = qr.Constructor.constructorId;
      const bestTime = parseQualiTime(qr.Q3) ?? parseQualiTime(qr.Q2) ?? parseQualiTime(qr.Q1);
      if (bestTime !== null) {
        lapTimes.push({ constructorId, timeS: bestTime });
      }
    }

    if (lapTimes.length === 0) continue;

    // Best lap per constructor
    const bestByConstructor: Record<string, number> = {};
    for (const { constructorId, timeS } of lapTimes) {
      if (!(constructorId in bestByConstructor) || timeS < bestByConstructor[constructorId]) {
        bestByConstructor[constructorId] = timeS;
      }
    }

    // Fastest car this session
    const poleTime = Math.min(...Object.values(bestByConstructor));

    // Compute gaps
    for (const [constructorId, bestTime] of Object.entries(bestByConstructor)) {
      const gap = bestTime - poleTime;
      if (!(constructorId in constructorGaps)) constructorGaps[constructorId] = [];
      constructorGaps[constructorId].push(gap);
    }
  }

  // Average gap across sessions
  const result: Record<string, number> = {};
  for (const [constructorId, gaps] of Object.entries(constructorGaps)) {
    result[constructorId] = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  }

  return result;
}

/**
 * Compute constructor race pace deltas from race lap times.
 * Uses median lap time per constructor (fuel/tire adjusted, rough).
 */
export function computeRacePaceDeltas(
  raceResults: ErgastRaceResult[],
  lastN: number = 5,
): Record<string, number> {
  // Ergast race results don't include lap times directly — we use finishing position
  // and time gap to approximate race pace. "Time" field gives gap to winner.
  const sessions = raceResults.slice(-lastN);
  const constructorGaps: Record<string, number[]> = {};

  for (const race of sessions) {
    const results = race.Results ?? [];
    const finishers = results.filter(r => r.Time?.time !== undefined && r.status === 'Finished');
    if (finishers.length < 5) continue;

    // Winner baseline
    const winnerTime = 3600; // normalized — we use relative laps completed as proxy
    // Actually, use position-based proxy: each position ≈ 0.5s/lap gap (rough)
    const lapsRaced = Number(results[0]?.laps ?? 50);

    for (const r of results) {
      const constructorId = r.Constructor.constructorId;
      const pos = Number(r.position);
      if (pos > 15) continue; // skip DNFs and backmarkers

      // Rough pace delta: position relative to winner × gap_per_position / laps
      // This is a proxy; FastF1 Python pipeline provides real lap times
      const paceProxy = (pos - 1) * 0.3 / lapsRaced; // ~0.3s/lap per position gap (rough)

      if (!(constructorId in constructorGaps)) constructorGaps[constructorId] = [];
      constructorGaps[constructorId].push(paceProxy);
    }
  }

  // Per-constructor: use best driver result as representative
  const result: Record<string, number> = {};
  for (const [constructorId, gaps] of Object.entries(constructorGaps)) {
    // Use median
    const sorted = [...gaps].sort((a, b) => a - b);
    result[constructorId] = sorted[Math.floor(sorted.length / 2)];
  }

  return result;
}

// ─── Main constructor power model ─────────────────────────────────────────────

export interface ConstructorModelInput {
  season: number;
  round: number;
  recentQualifying: ErgastQualifyingResult[];
  recentRaces: ErgastRaceResult[];
  context: RaceContext;
  // Python-computed values (from FastF1 data pipeline, if available)
  fastf1PaceDeltas?: Record<string, number>;
}

export function buildConstructorPowerModel(input: ConstructorModelInput): ConstructorPaceDelta[] {
  const { season, round, recentQualifying, recentRaces, context } = input;

  // Determine season phase and blending weights
  const { priorWeight, currentWeight, dataSource } = getBlendingWeights(round, season);
  logger.info({ round, priorWeight, currentWeight, dataSource }, 'Constructor power model blending');

  // Compute current-season pace deltas
  const qualiDeltas = recentQualifying.length > 0
    ? computeQualiPaceDeltas(recentQualifying, Math.min(recentQualifying.length, 3))
    : {};
  const raceDeltas = recentRaces.length > 0
    ? computeRacePaceDeltas(recentRaces, Math.min(recentRaces.length, 5))
    : {};

  // Use FastF1 deltas if available (more accurate)
  const fastf1Deltas = input.fastf1PaceDeltas ?? {};

  // All known constructors
  const constructorIds = Object.keys(PRIOR_SEASON_DELTAS);

  const results: ConstructorPaceDelta[] = constructorIds.map(constructorId => {
    const priorDelta = PRIOR_SEASON_DELTAS[constructorId] ?? 0.500;

    // Current-season qualifying delta
    const currentQualiDelta = qualiDeltas[constructorId] ?? priorDelta;
    // Current-season race pace delta
    const currentRaceDelta = raceDeltas[constructorId] ?? currentQualiDelta;
    // FastF1 overrides if available
    const ff1Delta = fastf1Deltas[constructorId];

    // Blended qualifying delta
    let qualifyingDelta: number;
    let racePaceDelta: number;

    if (ff1Delta !== undefined) {
      // FastF1 data is most accurate
      qualifyingDelta = ff1Delta * 0.6 + currentQualiDelta * 0.3 + priorDelta * 0.1;
      racePaceDelta = ff1Delta;
    } else if (currentWeight > 0 && (currentQualiDelta !== priorDelta || Object.keys(qualiDeltas).length > 0)) {
      qualifyingDelta = priorDelta * priorWeight + currentQualiDelta * currentWeight;
      racePaceDelta = priorDelta * priorWeight + currentRaceDelta * currentWeight;
    } else {
      qualifyingDelta = priorDelta;
      racePaceDelta = priorDelta;
    }

    // Blended delta: 60% qualifying, 40% race pace
    const blendedDelta = qualifyingDelta * 0.6 + racePaceDelta * 0.4;

    // Circuit-specific adjustment
    const circuitAdj = CIRCUIT_ADJUSTMENTS[context.circuitId]?.[constructorId] ?? 0;
    const circuitDelta = circuitAdj;

    // Final delta: blended + circuit adjustment
    let finalDelta = blendedDelta + circuitDelta;
    finalDelta = Math.max(0, finalDelta); // can't be faster than fastest car

    // Upgrade trajectory (placeholder; Python pipeline fills real values)
    const upgradeTrajectory = 0;

    // Confidence
    const confidence = currentWeight > 0.5 ? 0.85 : priorWeight > 0.8 ? 0.6 : 0.75;

    return {
      constructorId,
      constructorName: constructorId,
      qualifyingDelta,
      racePaceDelta,
      blendedDelta,
      circuitDelta,
      finalDelta,
      reliabilityRate: PRIOR_RELIABILITY[constructorId] ?? 0.90,
      pitStopAvg: PIT_STOP_AVGS[constructorId] ?? 2.7,
      upgradeTrajectory,
      dataSource: dataSource as ConstructorPaceDelta['dataSource'],
      confidence,
    };
  });

  // Normalize so fastest constructor = 0.000
  const fastestDelta = Math.min(...results.map(r => r.finalDelta));
  for (const r of results) {
    r.qualifyingDelta = Math.max(0, r.qualifyingDelta - fastestDelta);
    r.racePaceDelta = Math.max(0, r.racePaceDelta - fastestDelta);
    r.blendedDelta = Math.max(0, r.blendedDelta - fastestDelta);
    r.finalDelta = Math.max(0, r.finalDelta - fastestDelta);
  }

  results.sort((a, b) => a.finalDelta - b.finalDelta);

  logger.info(
    results.map(r => `${r.constructorId}: +${r.finalDelta.toFixed(3)}s`).join(', '),
    'Constructor power model',
  );

  return results;
}

// ─── Season phase and blending weights ────────────────────────────────────────

export function getBlendingWeights(round: number, season: number): {
  priorWeight: number;
  currentWeight: number;
  dataSource: string;
} {
  // 2026 is a major regulation change year (new engine regs + aerodynamic changes)
  const isRegChangeYear = season === 2026;

  if (round <= 0) {
    return { priorWeight: 1.0, currentWeight: 0.0, dataSource: 'prior_season' };
  }

  if (isRegChangeYear) {
    // Heavily discount prior season in regulation change years
    if (round === 1) return { priorWeight: 0.40, currentWeight: 0.60, dataSource: 'blended' };
    if (round <= 3) return { priorWeight: 0.20, currentWeight: 0.80, dataSource: 'blended' };
    return { priorWeight: 0.05, currentWeight: 0.95, dataSource: 'current' };
  }

  // Standard season blending
  if (round === 1) return { priorWeight: 0.70, currentWeight: 0.30, dataSource: 'blended' };
  if (round <= 3) return { priorWeight: 0.50, currentWeight: 0.50, dataSource: 'blended' };
  if (round <= 5) return { priorWeight: 0.30, currentWeight: 0.70, dataSource: 'blended' };
  if (round <= 8) return { priorWeight: 0.15, currentWeight: 0.85, dataSource: 'blended' };
  return { priorWeight: 0.0, currentWeight: 1.0, dataSource: 'current' };
}

// ─── Constructor lookup ───────────────────────────────────────────────────────

export function getConstructorDelta(
  constructorId: string,
  model: ConstructorPaceDelta[],
): ConstructorPaceDelta | null {
  return model.find(c => c.constructorId === constructorId) ?? null;
}
