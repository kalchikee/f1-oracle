// F1 Oracle v4.1 — Race Simulation Engine
// 10,000 iteration Monte Carlo simulation producing full finishing order distributions.
// F1 is an ORDINAL prediction problem: 20 drivers finishing in a specific order.

import { logger } from '../logger.js';
import { DRIVERS_2026, CONSTRUCTORS_2026 } from '../api/f1Client.js';
import { eloToPaceDelta } from '../features/driverElo.js';
import { getConstructorDelta } from '../features/constructorPower.js';
import type {
  DriverSimResult,
  RaceSimulation,
  DriverFeatures,
  ConstructorPaceDelta,
  RaceContext,
} from '../types.js';

const DEFAULT_SIMS = 10_000;

// ─── Normal distribution sampler (Box-Muller) ─────────────────────────────────

function randn(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─── Race noise parameters ────────────────────────────────────────────────────

// Base σ in seconds/lap — different conditions add variance
function getRaceNoiseStdDev(context: RaceContext): number {
  let sigma = 0.25; // base noise (dry race, permanent circuit)
  if (context.weather === 'wet') sigma += 0.40;
  if (context.weather === 'mixed') sigma += 0.25;
  if (context.circuitType === 'street') sigma += 0.15;
  if (context.safetyCarProbability > 0.5) sigma += 0.10;
  return sigma;
}

// ─── Grid position effect on race pace ───────────────────────────────────────

// Being in traffic costs time. Front-row cars have clean air advantage.
// Returns pace adjustment in seconds (positive = slower)
function gridPositionEffect(gridPos: number, overtakingDifficulty: number): number {
  if (gridPos <= 0) return 0; // no grid position (will be simulated)
  // Traffic penalty increases with difficulty and starting position
  const baseTrafficPenalty = (gridPos - 1) * 0.012; // 0.012s/lap per grid position behind P1
  return baseTrafficPenalty * (1 + overtakingDifficulty * 0.5);
}

// ─── DNF simulation ───────────────────────────────────────────────────────────

function didDNF(reliabilityRate: number): boolean {
  return Math.random() > reliabilityRate;
}

// ─── Safety car effect ────────────────────────────────────────────────────────

function safetyCarOccurred(scProbability: number): boolean {
  return Math.random() < scProbability;
}

// ─── Per-driver expected pace ─────────────────────────────────────────────────

interface DriverPaceInput {
  driverId: string;
  constructorId: string;
  constructorDelta: number;   // seconds/lap behind fastest constructor
  eloRating: number;
  gridPosition: number | null;
  teammateDelta: number;      // seconds gap to teammate in qualifying (negative = faster)
  wetWeatherRating: number;   // bonus in wet (negative = faster in wet)
  tireManagement: number;     // 0–1, higher = better (less pace loss late)
  experience: number;         // career starts
  penaltyFlag: number;
  circuitHistory: number;     // avg historical position at this circuit
}

function computeExpectedPace(
  driver: DriverPaceInput,
  context: RaceContext,
): number {
  let pace = driver.constructorDelta; // constructor is the dominant factor

  // Driver Elo adjustment (0.20s/lap spread for full Elo range)
  const eloAdjust = eloToPaceDelta(driver.eloRating);
  pace += eloAdjust;

  // Weather adjustment
  if (context.weather === 'wet' || context.weather === 'mixed') {
    pace += driver.wetWeatherRating * (context.weather === 'wet' ? 1.0 : 0.5);
  }

  // Experience penalty for rookies
  if (driver.experience < 20) {
    pace += 0.05; // rookies are ~0.05s/lap slower initially
  }

  // Circuit history — small adjustment
  if (driver.circuitHistory > 0) {
    // If avg historical position > 5, slight penalty
    const histAdj = (driver.circuitHistory - 5) * 0.005;
    pace += histAdj;
  }

  // Grid position effect (only if actual grid is known)
  if (driver.gridPosition !== null && driver.gridPosition > 0) {
    pace += gridPositionEffect(driver.gridPosition, context.overtakingDifficulty);
  }

  // Grid penalty makes things worse
  if (driver.penaltyFlag) pace += 0.015;

  return pace;
}

// ─── Single race simulation ───────────────────────────────────────────────────

interface SimDriver {
  driverId: string;
  constructorId: string;
  expectedPace: number;
  noiseSigma: number;
  reliabilityRate: number;
  gridPosition: number | null;
}

function simulateOneRace(
  drivers: SimDriver[],
  context: RaceContext,
  hasSafetyCar: boolean,
): Array<{ driverId: string; position: number; dnf: boolean }> {
  const results: Array<{ driverId: string; pace: number; dnf: boolean; gridPos: number }> = [];

  for (const driver of drivers) {
    const dnf = didDNF(driver.reliabilityRate);
    if (dnf) {
      // DNF position will be ranked last
      results.push({ driverId: driver.driverId, pace: 9999, dnf: true, gridPos: driver.gridPosition ?? 20 });
      continue;
    }

    // Race pace: expected pace + noise
    let racePace = driver.expectedPace + randn() * driver.noiseSigma;

    // Safety car randomizes field somewhat
    if (hasSafetyCar) {
      racePace += Math.random() * 0.15; // SC adds variance
    }

    // If no qualifying data, simulate from constructor pace + noise
    const gridPos = driver.gridPosition ?? Math.max(1, Math.round(driver.expectedPace * 8 + 1 + randn() * 3));
    results.push({ driverId: driver.driverId, pace: racePace, dnf: false, gridPos });
  }

  // Sort by pace (fastest first), DNFs at the end
  results.sort((a, b) => {
    if (a.dnf && !b.dnf) return 1;
    if (!a.dnf && b.dnf) return -1;
    return a.pace - b.pace;
  });

  return results.map((r, i) => ({ driverId: r.driverId, position: i + 1, dnf: r.dnf }));
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export interface SimulationInput {
  driverFeatures: DriverFeatures[];
  constructorModel: ConstructorPaceDelta[];
  eloMap: Map<string, number>;
  context: RaceContext;
  simulations?: number;
}

export function runRaceSimulation(input: SimulationInput): RaceSimulation {
  const { driverFeatures, constructorModel, eloMap, context } = input;
  const numSims = input.simulations ?? DEFAULT_SIMS;

  logger.info(
    { round: context.round, grandPrix: context.grandPrix, mode: context.seasonPhase, sims: numSims },
    'Running race simulation',
  );

  const noiseSigma = getRaceNoiseStdDev(context);
  const simMode = driverFeatures.some(d => d.qualiPosition !== null)
    ? 'post_qualifying'
    : driverFeatures.some(d => d.circuitHistory !== 0)
      ? 'practice_only'
      : 'pre_qualifying';

  // Build per-driver sim inputs
  const simDrivers: SimDriver[] = driverFeatures.map(df => {
    const constrDelta = getConstructorDelta(df.constructorId, constructorModel);
    const elo = eloMap.get(df.driverId) ?? 1500;

    const paceInput: DriverPaceInput = {
      driverId: df.driverId,
      constructorId: df.constructorId,
      constructorDelta: constrDelta?.finalDelta ?? 0.5,
      eloRating: elo,
      gridPosition: df.qualiPosition,
      teammateDelta: df.teammateDelta,
      wetWeatherRating: df.wetWeatherRating,
      tireManagement: df.tireManagement,
      experience: df.experience,
      penaltyFlag: df.penaltyFlag,
      circuitHistory: df.circuitHistory,
    };

    return {
      driverId: df.driverId,
      constructorId: df.constructorId,
      expectedPace: computeExpectedPace(paceInput, context),
      noiseSigma,
      reliabilityRate: constrDelta?.reliabilityRate ?? 0.90,
      gridPosition: df.qualiPosition,
    };
  });

  // Position frequency accumulators [driver][position 1-20]
  const positionCounts = new Map<string, number[]>();
  const dnfCounts = new Map<string, number>();
  for (const driver of simDrivers) {
    positionCounts.set(driver.driverId, new Array(21).fill(0));
    dnfCounts.set(driver.driverId, 0);
  }

  // Run simulations
  for (let i = 0; i < numSims; i++) {
    const hasSC = safetyCarOccurred(context.safetyCarProbability);
    const raceResult = simulateOneRace(simDrivers, context, hasSC);

    for (const { driverId, position, dnf } of raceResult) {
      const counts = positionCounts.get(driverId)!;
      counts[position] = (counts[position] ?? 0) + 1;
      if (dnf) dnfCounts.set(driverId, (dnfCounts.get(driverId) ?? 0) + 1);
    }
  }

  // Build results
  const results: DriverSimResult[] = simDrivers.map(driver => {
    const counts = positionCounts.get(driver.driverId)!;
    const total = numSims;

    const winProb = counts[1] / total;
    const podiumProb = (counts[1] + counts[2] + counts[3]) / total;
    const top5Prob = counts.slice(1, 6).reduce((a, b) => a + b, 0) / total;
    const top10Prob = counts.slice(1, 11).reduce((a, b) => a + b, 0) / total;
    const dnfProb = (dnfCounts.get(driver.driverId) ?? 0) / total;

    // Expected position (weighted average)
    let expectedPos = 0;
    for (let p = 1; p <= 20; p++) {
      expectedPos += p * (counts[p] / total);
    }

    // Fastest lap — approximate: driver with best expected pace has highest prob
    const fastestLapProb = Math.max(0, winProb * 1.5); // winner often sets fastest lap

    // Position probability distribution
    const positionDistribution = counts.slice(1).map(c => c / total);

    // Find teammate for H2H
    const df = driverFeatures.find(d => d.driverId === driver.driverId)!;
    const teammate = driverFeatures.find(
      d => d.constructorId === driver.constructorId && d.driverId !== driver.driverId,
    );
    const teammateH2HProb = teammate
      ? computeH2HProbability(
          positionCounts.get(driver.driverId)!,
          positionCounts.get(teammate.driverId)!,
          numSims,
        )
      : 0.5;

    const constr = CONSTRUCTORS_2026.find(c => c.id === driver.constructorId);
    const d = DRIVERS_2026.find(d => d.id === driver.driverId);

    return {
      driverId: driver.driverId,
      driverName: d?.name ?? driver.driverId,
      constructorId: driver.constructorId,
      constructorName: constr?.shortName ?? driver.constructorId,
      winProbability: winProb,
      podiumProbability: podiumProb,
      top5Probability: top5Prob,
      top10Probability: top10Prob,
      pointsProbability: top10Prob,
      fastestLapProbability: fastestLapProb,
      dnfProbability: dnfProb,
      expectedPosition: expectedPos,
      predictedPosition: Math.round(expectedPos),
      positionDistribution,
      calibratedWinProb: winProb,   // placeholder; Platt scaling applied separately
      calibratedPodiumProb: podiumProb,
      teammateH2HProbability: teammateH2HProb,
    };
  });

  // Sort by expected position
  results.sort((a, b) => a.expectedPosition - b.expectedPosition);
  const predictedTopTen = results.slice(0, 10).map(r => r.driverId);

  logger.info(
    `Simulation complete. Predicted: ${results.slice(0, 3).map(r => `${r.driverName}(${(r.winProbability * 100).toFixed(1)}%)`).join(', ')}`,
  );

  return {
    raceId: `${context.season}_${context.round}`,
    round: context.round,
    season: context.season,
    grandPrix: context.grandPrix,
    circuit: context.circuit,
    simulations: numSims,
    simulationMode: simMode,
    results,
    predictedTopTen,
    safetyCarProb: context.safetyCarProbability,
    wetRaceProb: context.rainProbability,
    createdAt: new Date().toISOString(),
  };
}

// ─── H2H probability from simulation counts ───────────────────────────────────

function computeH2HProbability(
  countsA: number[],
  countsB: number[],
  total: number,
): number {
  // Count simulations where A finished ahead of B
  let aAhead = 0;
  for (let pos = 1; pos <= 20; pos++) {
    const probA = countsA[pos] / total;
    // P(A at pos) × P(B behind pos) = sum of B at positions > pos
    for (let posB = pos + 1; posB <= 20; posB++) {
      aAhead += (countsA[pos] / total) * (countsB[posB] / total);
    }
  }
  // Normalize
  return Math.min(0.98, Math.max(0.02, aAhead));
}

// ─── Apply Platt scaling calibration (loaded from Python output) ──────────────

export function applyCalibration(
  results: DriverSimResult[],
  // Calibration params from python/train_calibration.py
  winCalibA: number = 1.0,
  winCalibB: number = 0.0,
): DriverSimResult[] {
  return results.map(r => ({
    ...r,
    calibratedWinProb: plattScale(r.winProbability, winCalibA, winCalibB),
    calibratedPodiumProb: plattScale(r.podiumProbability, winCalibA, winCalibB),
  }));
}

function plattScale(prob: number, a: number, b: number): number {
  const logit = a * Math.log(prob / (1 - Math.max(0.001, Math.min(0.999, prob)))) + b;
  return 1 / (1 + Math.exp(-logit));
}

// ─── Default driver features (for pre-qualifying predictions) ─────────────────

export function buildDefaultDriverFeatures(
  circuitId: string,
  season: number,
): DriverFeatures[] {
  return DRIVERS_2026.map(driver => ({
    driverId: driver.id,
    driverName: driver.name,
    constructorId: driver.constructorId,
    elo: 1500,
    eloVsTeammate: 0,
    qualiPosition: null,
    qualiToRaceGain: 0,
    wetWeatherRating: 0,
    overtakingAbility: 0.5,
    tireManagement: 0.5,
    circuitHistory: 0,
    experience: driver.careerStarts,
    penaltyFlag: 0,
    sprintResult: null,
    teammateDelta: 0,
  }));
}
