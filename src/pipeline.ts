// F1 Oracle v4.1 — Main Pipeline
// Orchestrates data fetching, constructor model, race simulation, and DB storage.

import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  getRaceCalendar,
  getCurrentRaceRound,
  getRecentQualifyingResults,
  getRecentRaceResults,
  getRaceResult,
  getQualifyingResult,
  getDriverStandings,
  getConstructorStandings,
  getCurrentF1Season,
  parseQualiTime,
  DRIVERS_2026,
} from './api/f1Client.js';
import { buildConstructorPowerModel } from './features/constructorPower.js';
import { initDriverElo, getDriverEloMap, updateEloAfterRace } from './features/driverElo.js';
import { runRaceSimulation, buildDefaultDriverFeatures, applyCalibration } from './models/raceSimulation.js';
import {
  initDb,
  persistDb,
  upsertConstructorPace,
  insertPrediction,
  getPredictionByRound,
  updatePredictionActuals,
  insertRaceResult,
  getRaceResults,
  getSeasonAccuracy,
  upsertSeasonAccuracy,
} from './db/database.js';
import { CIRCUIT_PROFILES } from './features/circuitProfiles.js';
import type {
  PipelineOptions,
  RaceContext,
  DriverFeatures,
  SeasonAccuracy,
  RaceSimulation,
} from './types.js';

// ─── Build race context ───────────────────────────────────────────────────────

function buildRaceContext(
  race: { season: number; round: number; grandPrix: string; circuit: string; circuitId: string; date: string; isSprintWeekend: boolean },
  totalRounds: number,
  round: number,
  season: number,
): RaceContext {
  const profile = CIRCUIT_PROFILES[race.circuitId] ?? CIRCUIT_PROFILES['default'];
  const isRegChangeYear = season === 2026;

  // Season phase
  let seasonPhase: RaceContext['seasonPhase'] = 'full';
  if (round === 0) seasonPhase = 'preseason';
  else if (round <= 3) seasonPhase = 'early';
  else if (round <= 8) seasonPhase = 'blending';
  else seasonPhase = 'full';

  return {
    raceId: `${season}_${round}`,
    season,
    round,
    totalRounds,
    grandPrix: race.grandPrix,
    circuit: race.circuit,
    circuitId: race.circuitId,
    country: race.circuitId, // placeholder
    date: race.date,
    fp1Date: null,
    fp2Date: null,
    fp3Date: null,
    qualifyingDate: null,
    sprintDate: null,
    isSprintWeekend: race.isSprintWeekend,
    circuitType: profile.type,
    overtakingDifficulty: profile.overtakingDifficulty,
    safetyCarProbability: profile.safetyCarProbability,
    tireDegradationRate: profile.tireDegradationRate,
    altitude: profile.altitude ?? 0,
    weather: 'dry',
    rainProbability: profile.rainProbability ?? 0.10,
    seasonPhase,
    isRegulationChangeYear: isRegChangeYear,
  };
}

// ─── Build driver features from qualifying results ────────────────────────────

async function buildDriverFeatures(
  season: number,
  round: number,
  eloMap: Map<string, number>,
): Promise<DriverFeatures[]> {
  const qualiResult = await getQualifyingResult(season, round);

  if (!qualiResult) {
    logger.info({ season, round }, 'No qualifying data — using default driver features');
    return buildDefaultDriverFeatures('default', season).map(df => ({
      ...df,
      elo: eloMap.get(df.driverId) ?? 1500,
    }));
  }

  // Build per-driver qualifying data
  const qualiData: Record<string, { position: number; timeS: number | null; constructorId: string }> = {};
  for (const qr of qualiResult.QualifyingResults) {
    qualiData[qr.Driver.driverId] = {
      position: Number(qr.position),
      timeS: parseQualiTime(qr.Q3) ?? parseQualiTime(qr.Q2) ?? parseQualiTime(qr.Q1),
      constructorId: qr.Constructor.constructorId,
    };
  }

  // Map each 2026 driver
  return DRIVERS_2026.map(driver => {
    const qd = qualiData[driver.id];
    const elo = eloMap.get(driver.id) ?? 1500;

    // Teammate delta
    const teammate = DRIVERS_2026.find(
      d => d.constructorId === driver.constructorId && d.id !== driver.id,
    );
    let teammateDelta = 0;
    if (teammate && qd?.timeS && qualiData[teammate.id]?.timeS) {
      teammateDelta = qd.timeS - (qualiData[teammate.id]?.timeS ?? qd.timeS);
    }

    return {
      driverId: driver.id,
      driverName: driver.name,
      constructorId: qd?.constructorId ?? driver.constructorId,
      elo,
      eloVsTeammate: 0,
      qualiPosition: qd?.position ?? null,
      qualiToRaceGain: 0,    // historical average (populated by Python pipeline)
      wetWeatherRating: 0,
      overtakingAbility: 0.5,
      tireManagement: 0.5,
      circuitHistory: 0,
      experience: driver.careerStarts,
      penaltyFlag: 0,
      sprintResult: null,
      teammateDelta,
    };
  });
}

// ─── Score previous race ──────────────────────────────────────────────────────

async function scorePreviousRace(
  season: number,
  round: number,
  currentSeasonAcc: SeasonAccuracy,
): Promise<SeasonAccuracy> {
  const raceResult = await getRaceResult(season, round);
  if (!raceResult) {
    logger.info({ season, round }, 'Race result not yet available');
    return currentSeasonAcc;
  }

  // Check if already scored
  const existingResults = getRaceResults(season, round);
  if (existingResults.length > 0) {
    logger.info({ season, round }, 'Race already scored');
    return currentSeasonAcc;
  }

  // Store race results
  for (const r of raceResult.Results ?? []) {
    insertRaceResult({
      raceId: `${season}_${round}`,
      season,
      round,
      grandPrix: raceResult.raceName,
      circuit: raceResult.circuit.circuitName,
      date: raceResult.date,
      driverId: r.Driver.driverId,
      driverName: `${r.Driver.givenName} ${r.Driver.familyName}`,
      constructorId: r.Constructor.constructorId,
      finishingPosition: Number(r.position),
      gridPosition: Number(r.grid),
      status: r.status,
      fastestLap: r.FastestLap?.rank === '1',
      points: 0,
    });
  }

  // Update Elo
  updateEloAfterRace(raceResult, season);

  // Score prediction
  const prediction = getPredictionByRound(season, round, 'post_qualifying')
    ?? getPredictionByRound(season, round, 'practice_only');

  if (!prediction) {
    logger.warn({ season, round }, 'No prediction found to score');
    return currentSeasonAcc;
  }

  const topTen = (raceResult.Results ?? [])
    .sort((a, b) => Number(a.position) - Number(b.position))
    .slice(0, 10)
    .map(r => r.Driver.driverId);

  const actualWinner = topTen[0] ?? '';
  const actualP2 = topTen[1] ?? '';
  const actualP3 = topTen[2] ?? '';
  const actualTopFive = topTen.slice(0, 5);
  const actualTopTen = topTen;

  const predictedResults: Array<{ driverId: string }> = JSON.parse(prediction.driverResults ?? '[]');
  const predictedWinner = predictedResults[0]?.driverId ?? '';
  const predictedTopFive = predictedResults.slice(0, 5).map(d => d.driverId);
  const predictedTopTen = predictedResults.slice(0, 10).map(d => d.driverId);

  const winnerCorrect = predictedWinner === actualWinner ? 1 : 0;
  const podiumCorrect = [prediction.predictedWinner, prediction.predictedP2, prediction.predictedP3]
    .filter((p, i) => p === [actualWinner, actualP2, actualP3][i]).length;
  const top5Correct = actualTopFive.filter(d => predictedTopFive.includes(d)).length;
  const top10Correct = actualTopTen.filter(d => predictedTopTen.includes(d)).length;

  updatePredictionActuals(season, round, {
    actualWinner,
    actualP2,
    actualP3,
    actualTopFive: JSON.stringify(actualTopFive),
    actualTopTen: JSON.stringify(actualTopTen),
    winnerCorrect,
    podiumCorrect,
    top5Correct,
    top10Correct,
  });

  // Update season accuracy
  const newAcc: SeasonAccuracy = {
    season,
    totalRaces: currentSeasonAcc.totalRaces + 1,
    winnerCorrect: currentSeasonAcc.winnerCorrect + winnerCorrect,
    winnerAccuracy: 0,
    podiumSlotsCorrect: currentSeasonAcc.podiumSlotsCorrect + podiumCorrect,
    podiumSlotsTotal: currentSeasonAcc.podiumSlotsTotal + 3,
    podiumSlotAccuracy: 0,
    top5SetCorrect: currentSeasonAcc.top5SetCorrect + (top5Correct >= 3 ? 1 : 0),
    top5SetAccuracy: 0,
    h2hCorrect: currentSeasonAcc.h2hCorrect,
    h2hTotal: currentSeasonAcc.h2hTotal,
    h2hAccuracy: 0,
    valueBetsWon: currentSeasonAcc.valueBetsWon,
    valueBetsLost: currentSeasonAcc.valueBetsLost,
    valueBetsROI: currentSeasonAcc.valueBetsROI,
  };

  const total = newAcc.totalRaces;
  newAcc.winnerAccuracy = total > 0 ? newAcc.winnerCorrect / total : 0;
  newAcc.podiumSlotAccuracy = newAcc.podiumSlotsTotal > 0
    ? newAcc.podiumSlotsCorrect / newAcc.podiumSlotsTotal : 0;
  newAcc.top5SetAccuracy = total > 0 ? newAcc.top5SetCorrect / total : 0;
  newAcc.h2hAccuracy = newAcc.h2hTotal > 0 ? newAcc.h2hCorrect / newAcc.h2hTotal : 0;

  upsertSeasonAccuracy(newAcc);
  logger.info({ winnerCorrect, podiumCorrect, season, round }, 'Race scored');

  return newAcc;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

export async function runPipeline(options: PipelineOptions = {}): Promise<RaceSimulation | null> {
  const season = options.season ?? getCurrentF1Season();

  await initDb();
  await initDriverElo(season);

  const calendar = await getRaceCalendar(season);
  if (calendar.length === 0) {
    logger.warn({ season }, 'Empty calendar — cannot run pipeline');
    return null;
  }

  const totalRounds = calendar.length;
  const round = options.round ?? (getCurrentRaceRound(calendar)?.round ?? 1);
  const mode = options.mode ?? 'qualifying';

  const race = calendar.find(r => r.round === round);
  if (!race) {
    logger.warn({ round, season }, 'Race not found in calendar');
    return null;
  }

  logger.info({ season, round, grandPrix: race.grandPrix, mode }, 'Pipeline running');

  // Score previous race if recap mode
  let seasonAcc: SeasonAccuracy = getSeasonAccuracy(season) ?? {
    season,
    totalRaces: 0,
    winnerCorrect: 0,
    winnerAccuracy: 0,
    podiumSlotsCorrect: 0,
    podiumSlotsTotal: 0,
    podiumSlotAccuracy: 0,
    top5SetCorrect: 0,
    top5SetAccuracy: 0,
    h2hCorrect: 0,
    h2hTotal: 0,
    h2hAccuracy: 0,
    valueBetsWon: 0,
    valueBetsLost: 0,
    valueBetsROI: 0,
  };

  if (mode === 'race' && round > 1) {
    seasonAcc = await scorePreviousRace(season, round - 1, seasonAcc);
  }

  // Fetch recent data
  const recentQualifying = await getRecentQualifyingResults(season, 3);
  const recentRaces = await getRecentRaceResults(season, 5);

  // Build race context
  const context = buildRaceContext(race, totalRounds, round, season);

  // Build constructor power model
  const constructorModel = buildConstructorPowerModel({
    season,
    round,
    recentQualifying,
    recentRaces,
    context,
  });

  // Persist constructor pace to DB
  for (const pace of constructorModel) {
    upsertConstructorPace(pace, season, round);
  }

  // Build driver features (with qualifying data if available)
  const eloMap = getDriverEloMap();
  const driverFeatures = await buildDriverFeatures(season, round, eloMap);

  // Run simulation
  const rawSim = runRaceSimulation({
    driverFeatures,
    constructorModel,
    eloMap,
    context,
    simulations: options.simulations ?? 10_000,
  });

  // Apply Platt calibration (trained on 2021–2025 backtest)
  const calibParams = loadCalibrationParams();
  const sim = {
    ...rawSim,
    results: applyCalibration(rawSim.results, calibParams.win_calibration.a, calibParams.win_calibration.b),
  };

  // Store prediction
  const predictedResults = sim.results;
  const pred = {
    raceId: `${season}_${round}`,
    season,
    round,
    grandPrix: race.grandPrix,
    circuit: race.circuit,
    simulationMode: sim.simulationMode,
    driverResults: JSON.stringify(predictedResults),
    predictedWinner: predictedResults[0]?.driverName ?? '',
    predictedP2: predictedResults[1]?.driverName ?? '',
    predictedP3: predictedResults[2]?.driverName ?? '',
    predictedTopFive: JSON.stringify(predictedResults.slice(0, 5).map(d => d.driverName)),
    predictedTopTen: JSON.stringify(predictedResults.slice(0, 10).map(d => d.driverName)),
    winnerProbability: predictedResults[0]?.calibratedWinProb ?? 0,
    podiumProb1: predictedResults[0]?.podiumProbability ?? 0,
    podiumProb2: predictedResults[1]?.podiumProbability ?? 0,
    podiumProb3: predictedResults[2]?.podiumProbability ?? 0,
    actualWinner: null,
    actualP2: null,
    actualP3: null,
    actualTopFive: null,
    actualTopTen: null,
    winnerCorrect: null,
    podiumCorrect: null,
    top5Correct: null,
    top10Correct: null,
    modelVersion: '4.1',
    createdAt: new Date().toISOString(),
  };

  insertPrediction(pred);

  if (options.verbose !== false) {
    printPredictionTable(sim);
  }

  persistDb();
  return sim;
}

// ─── Console output table ─────────────────────────────────────────────────────

// ─── Load Platt calibration params ───────────────────────────────────────────

interface CalibParams {
  win_calibration: { a: number; b: number };
  podium_calibration: { a: number; b: number };
}

function loadCalibrationParams(): CalibParams {
  const path = resolve(__dirname, '../data/calibration_params.json');
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as CalibParams;
    } catch { /* fall through */ }
  }
  return { win_calibration: { a: 1.0, b: 0.0 }, podium_calibration: { a: 1.0, b: 0.0 } };
}

function printPredictionTable(sim: RaceSimulation): void {
  console.log(`\n🏁 ${sim.grandPrix} — ${sim.season} Round ${sim.round}`);
  console.log(`   Mode: ${sim.simulationMode} | Simulations: ${sim.simulations.toLocaleString()}\n`);
  console.log('  Pos  Driver                Constructor       Win%    Pod%    Top5%   DNF%');
  console.log('  ─────────────────────────────────────────────────────────────────────────');

  for (const [i, r] of sim.results.slice(0, 15).entries()) {
    const pos = (i + 1).toString().padStart(2, ' ');
    const name = r.driverName.padEnd(20, ' ');
    const constr = r.constructorName.padEnd(16, ' ');
    const win = (r.calibratedWinProb * 100).toFixed(1).padStart(5, ' ') + '%';
    const pod = (r.podiumProbability * 100).toFixed(1).padStart(5, ' ') + '%';
    const top5 = (r.top5Probability * 100).toFixed(1).padStart(5, ' ') + '%';
    const dnf = (r.dnfProbability * 100).toFixed(1).padStart(4, ' ') + '%';
    console.log(`  ${pos}  ${name}${constr}${win}   ${pod}   ${top5}   ${dnf}`);
  }
  console.log('');
}
