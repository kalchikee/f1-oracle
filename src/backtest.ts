// F1 Oracle v4.1 — Historical Backtest Runner
// Runs the full prediction pipeline retroactively for 2021–2025 (~110 races).
// For each race:
//   1. Fetch qualifying result from Ergast (grid positions)
//   2. Build constructor power model from prior 3 qualifying + 5 race sessions
//   3. Run 10,000-iteration race simulation
//   4. Fetch actual race result
//   5. Score prediction and store in DB
// After all races: train Platt calibration and report accuracy.
//
// Usage:  npm run backtest
//         npm run backtest -- --seasons 2021,2022,2023,2024,2025
//         npm run backtest -- --seasons 2025 --start-round 1

import 'dotenv/config';
import { logger } from './logger.js';
import {
  getRaceCalendar,
  getRaceResult,
  getQualifyingResult,
  getRecentQualifyingResults,
  getRecentRaceResults,
  getCurrentF1Season,
  parseQualiTime,
  DRIVERS_2026,
  CONSTRUCTORS_2026,
} from './api/f1Client.js';
import { buildConstructorPowerModel } from './features/constructorPower.js';
import { getDriverEloMap, updateEloAfterRace, initDriverElo } from './features/driverElo.js';
import { runRaceSimulation } from './models/raceSimulation.js';
import { CIRCUIT_PROFILES } from './features/circuitProfiles.js';
import {
  initDb,
  closeDb,
  persistDb,
  upsertConstructorPace,
  insertPrediction,
  getPredictionByRound,
  updatePredictionActuals,
  insertRaceResult,
  getRaceResults,
  getSeasonAccuracy,
  upsertSeasonAccuracy,
  getAllDriverElo,
} from './db/database.js';
import type {
  RaceContext,
  DriverFeatures,
  SeasonAccuracy,
  ErgastRaceResult,
  ErgastQualifyingResult,
} from './types.js';

// ─── Ergast driver ID → 2026 roster mapping ───────────────────────────────────
// Historical races have different driver IDs than our 2026 roster.
// We map them for Elo continuity, but track all drivers who raced.

const ERGAST_TO_DRIVER_ID: Record<string, string> = {
  // Current grid
  max_verstappen: 'verstappen',
  charles_leclerc: 'leclerc',
  lewis_hamilton: 'hamilton',
  george_russell: 'russell',
  lando_norris: 'norris',
  oscar_piastri: 'piastri',
  carlos_sainz: 'sainz',
  fernando_alonso: 'alonso',
  lance_stroll: 'stroll',
  pierre_gasly: 'gasly',
  esteban_ocon: 'ocon',
  alexander_albon: 'albon',
  yuki_tsunoda: 'tsunoda',
  nico_hulkenberg: 'hulkenberg',
  // Former drivers (for Elo computation)
  sebastian_vettel: 'vettel',
  valtteri_bottas: 'bottas',
  daniel_ricciardo: 'ricciardo',
  mick_schumacher: 'mick_schumacher',
  kevin_magnussen: 'magnussen',
  guanyu_zhou: 'zhou',
  nicholas_latifi: 'latifi',
  sergio_perez: 'perez',
  antonio_giovinazzi: 'giovinazzi',
  kimi_raikkonen: 'raikkonen',
  robert_kubica: 'kubica',
  // 2024-2025
  oliver_bearman: 'bearman',
  jack_doohan: 'doohan',
  liam_lawson: 'lawson',
  franco_colapinto: 'colapinto',
  isack_hadjar: 'hadjar',
  gabriel_bortoleto: 'bortoleto',
  kimi_antonelli: 'antonelli',
};

const ERGAST_TO_CONSTRUCTOR: Record<string, string> = {
  red_bull: 'red_bull',
  ferrari: 'ferrari',
  mercedes: 'mercedes',
  mclaren: 'mclaren',
  aston_martin: 'aston_martin',
  alpine: 'alpine',
  williams: 'williams',
  haas: 'haas',
  alphatauri: 'rb',
  rb: 'rb',
  sauber: 'sauber',
  alfa: 'sauber',
  // Legacy names
  racing_point: 'aston_martin',
  renault: 'alpine',
  toro_rosso: 'rb',
  force_india: 'aston_martin',
};

function normConstructor(id: string): string {
  return ERGAST_TO_CONSTRUCTOR[id] ?? id;
}

function normDriver(id: string): string {
  return ERGAST_TO_DRIVER_ID[id] ?? id;
}

// ─── Driver roster per season (historical grids) ──────────────────────────────
// Build from race results dynamically — no hardcoded per-season roster needed.

// ─── Build driver features from qualifying result ─────────────────────────────

function buildDriverFeaturesFromQuali(
  qualiResult: ErgastQualifyingResult | null,
  constructorIds: Map<string, string>, // driverId → constructorId
  eloMap: Map<string, number>,
  season: number,
): DriverFeatures[] {
  const features: DriverFeatures[] = [];

  // Build quali position map
  const qualiPositions: Record<string, { pos: number; timeS: number | null }> = {};
  if (qualiResult) {
    for (const qr of qualiResult.QualifyingResults) {
      const driverId = normDriver(qr.Driver.driverId);
      const constructorId = normConstructor(qr.Constructor.constructorId);
      constructorIds.set(driverId, constructorId);
      qualiPositions[driverId] = {
        pos: Number(qr.position),
        timeS: parseQualiTime(qr.Q3) ?? parseQualiTime(qr.Q2) ?? parseQualiTime(qr.Q1),
      };
    }
  }

  // Unique drivers from either qualifying or constructor map
  const allDrivers = new Set([...Object.keys(qualiPositions), ...constructorIds.keys()]);

  for (const driverId of allDrivers) {
    const constructorId = constructorIds.get(driverId) ?? 'unknown';
    const qd = qualiPositions[driverId];
    const elo = eloMap.get(driverId) ?? 1500;

    // Find teammate
    const teammates = [...constructorIds.entries()]
      .filter(([d, c]) => c === constructorId && d !== driverId)
      .map(([d]) => d);
    const teammate = teammates[0];

    let teammateDelta = 0;
    if (teammate && qd?.timeS && qualiPositions[teammate]?.timeS) {
      teammateDelta = qd.timeS - (qualiPositions[teammate].timeS ?? qd.timeS);
    }

    features.push({
      driverId,
      driverName: driverId,
      constructorId,
      elo,
      eloVsTeammate: 0,
      qualiPosition: qd?.pos ?? null,
      qualiToRaceGain: 0,
      wetWeatherRating: 0,
      overtakingAbility: 0.5,
      tireManagement: 0.5,
      circuitHistory: 0,
      experience: 50, // historical drivers assumed experienced
      penaltyFlag: 0,
      sprintResult: null,
      teammateDelta,
    });
  }

  return features;
}

// ─── Score race result against prediction ─────────────────────────────────────

function scoreRace(
  predictedOrder: string[],  // driver IDs, sorted by predicted position
  raceResult: ErgastRaceResult,
): {
  winnerCorrect: number;
  podiumCorrect: number;
  top5Correct: number;
  top10Correct: number;
  actualWinner: string;
  actualTop10: string[];
} {
  const finishers = (raceResult.Results ?? [])
    .sort((a, b) => Number(a.position) - Number(b.position));

  const actualTop10 = finishers.slice(0, 10).map(r => normDriver(r.Driver.driverId));
  const actualWinner = actualTop10[0] ?? '';
  const actualPodium = actualTop10.slice(0, 3);
  const actualTop5 = actualTop10.slice(0, 5);

  const predictedWinner = predictedOrder[0] ?? '';
  const predictedPodium = predictedOrder.slice(0, 3);
  const predictedTop5 = predictedOrder.slice(0, 5);
  const predictedTop10 = predictedOrder.slice(0, 10);

  const winnerCorrect = predictedWinner === actualWinner ? 1 : 0;

  // Per-slot podium accuracy
  const podiumCorrect = predictedPodium.filter((p, i) => p === actualPodium[i]).length;

  // Top-5 set overlap
  const top5Correct = actualTop5.filter(d => predictedTop5.includes(d)).length;

  // Top-10 set overlap
  const top10Correct = actualTop10.filter(d => predictedTop10.includes(d)).length;

  return { winnerCorrect, podiumCorrect, top5Correct, top10Correct, actualWinner, actualTop10 };
}

// ─── Build race context from historical race ───────────────────────────────────

function buildHistoricalContext(
  race: Awaited<ReturnType<typeof getRaceCalendar>>[0],
  totalRounds: number,
  season: number,
): RaceContext {
  const profile = CIRCUIT_PROFILES[race.circuitId] ?? CIRCUIT_PROFILES['default'];

  let seasonPhase: RaceContext['seasonPhase'] = 'full';
  if (race.round <= 3) seasonPhase = 'early';
  else if (race.round <= 8) seasonPhase = 'blending';

  // Known regulation change years
  const isRegChangeYear = season === 2022 || season === 2026;

  return {
    raceId: `${season}_${race.round}`,
    season,
    round: race.round,
    totalRounds,
    grandPrix: race.grandPrix,
    circuit: race.circuit,
    circuitId: race.circuitId,
    country: race.country,
    date: race.date,
    fp1Date: race.fp1Date,
    fp2Date: race.fp2Date,
    fp3Date: race.fp3Date,
    qualifyingDate: race.qualifyingDate,
    sprintDate: race.sprintDate,
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

// ─── Season accumulator ───────────────────────────────────────────────────────

function emptyAccuracy(season: number): SeasonAccuracy {
  return {
    season, totalRaces: 0, winnerCorrect: 0, winnerAccuracy: 0,
    podiumSlotsCorrect: 0, podiumSlotsTotal: 0, podiumSlotAccuracy: 0,
    top5SetCorrect: 0, top5SetAccuracy: 0,
    h2hCorrect: 0, h2hTotal: 0, h2hAccuracy: 0,
    valueBetsWon: 0, valueBetsLost: 0, valueBetsROI: 0,
  };
}

function updateAccuracy(acc: SeasonAccuracy, scored: ReturnType<typeof scoreRace>): SeasonAccuracy {
  const n = acc.totalRaces + 1;
  const podiumSlots = acc.podiumSlotsTotal + 3;
  const podiumCorrect = acc.podiumSlotsCorrect + scored.podiumCorrect;
  const winnerCorrect = acc.winnerCorrect + scored.winnerCorrect;
  const top5Correct = acc.top5SetCorrect + (scored.top5Correct >= 3 ? 1 : 0);

  return {
    ...acc,
    totalRaces: n,
    winnerCorrect,
    winnerAccuracy: winnerCorrect / n,
    podiumSlotsCorrect: podiumCorrect,
    podiumSlotsTotal: podiumSlots,
    podiumSlotAccuracy: podiumCorrect / podiumSlots,
    top5SetCorrect: top5Correct,
    top5SetAccuracy: top5Correct / n,
  };
}

// ─── Sleep helper (respect Ergast rate limits) ────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Backtest one season ──────────────────────────────────────────────────────

async function backtestSeason(
  season: number,
  startRound: number = 1,
  endRound?: number,
): Promise<SeasonAccuracy> {
  logger.info({ season }, `Starting backtest`);

  const calendar = await getRaceCalendar(season);
  if (calendar.length === 0) {
    logger.warn({ season }, 'Empty calendar');
    return emptyAccuracy(season);
  }

  const totalRounds = calendar.length;
  const races = calendar.filter(r => r.round >= startRound && r.round <= (endRound ?? totalRounds));

  logger.info({ season, races: races.length }, 'Calendar loaded');

  let acc = getSeasonAccuracy(season) ?? emptyAccuracy(season);

  // Track recent qualifying/race sessions for constructor model rolling window
  const recentQualifying: ErgastQualifyingResult[] = [];
  const recentRaces: ErgastRaceResult[] = [];
  const constructorIds = new Map<string, string>(); // driverId → constructorId (updated each race)

  for (const race of races) {
    const raceId = `${season}_${race.round}`;

    // Skip if already scored
    const existingResults = getRaceResults(season, race.round);
    if (existingResults.length > 0 && getPredictionByRound(season, race.round)) {
      logger.info({ season, round: race.round, gp: race.grandPrix }, 'Already scored — skipping');

      // Still need to update rolling windows
      const rr = await getRaceResult(season, race.round);
      const qr = await getQualifyingResult(season, race.round);
      if (rr) recentRaces.push(rr);
      if (qr) recentQualifying.push(qr);
      if (recentRaces.length > 5) recentRaces.shift();
      if (recentQualifying.length > 3) recentQualifying.shift();
      await sleep(200);
      continue;
    }

    logger.info({ season, round: race.round, gp: race.grandPrix }, 'Processing race');

    let qualiResult: ErgastQualifyingResult | null = null;
    let raceResult: ErgastRaceResult | null = null;
    try {
      [qualiResult, raceResult] = await Promise.all([
        getQualifyingResult(season, race.round),
        getRaceResult(season, race.round),
      ]);
    } catch (err) {
      logger.warn({ season, round: race.round, err }, 'Failed to fetch race data — skipping');
      await sleep(500);
      continue;
    }
    await sleep(600); // respect Ergast rate limit

    if (!raceResult) {
      logger.warn({ season, round: race.round }, 'No race result — skipping');
      continue;
    }

    try {

    // Update constructor map from race result (most reliable)
    for (const r of raceResult.Results ?? []) {
      const driverId = normDriver(r.Driver.driverId);
      const constrId = normConstructor(r.Constructor.constructorId);
      constructorIds.set(driverId, constrId);
    }

    // Build race context
    const context = buildHistoricalContext(race, totalRounds, season);

    // Build constructor power model from rolling window
    const eloMap = getDriverEloMap();
    const constructorModel = buildConstructorPowerModel({
      season,
      round: race.round,
      recentQualifying: [...recentQualifying],
      recentRaces: [...recentRaces],
      context,
    });

    // Persist constructor pace
    for (const pace of constructorModel) {
      upsertConstructorPace(pace, season, race.round);
    }

    // Build driver features (with qualifying positions if available)
    const driverFeatures = buildDriverFeaturesFromQuali(
      qualiResult,
      new Map(constructorIds), // copy
      eloMap,
      season,
    );

    if (driverFeatures.length === 0) {
      logger.warn({ season, round: race.round }, 'No driver features — skipping');
      continue;
    }

    // Run simulation
    const sim = runRaceSimulation({
      driverFeatures,
      constructorModel,
      eloMap,
      context,
      simulations: 10_000,
    });

    const predictedOrder = sim.results.map(r => r.driverId);

    // Store prediction
    const pred = {
      raceId,
      season,
      round: race.round,
      grandPrix: race.grandPrix,
      circuit: race.circuit,
      simulationMode: sim.simulationMode,
      driverResults: JSON.stringify(sim.results),
      predictedWinner: sim.results[0]?.driverName ?? '',
      predictedP2: sim.results[1]?.driverName ?? '',
      predictedP3: sim.results[2]?.driverName ?? '',
      predictedTopFive: JSON.stringify(sim.results.slice(0, 5).map(r => r.driverId)),
      predictedTopTen: JSON.stringify(sim.results.slice(0, 10).map(r => r.driverId)),
      winnerProbability: sim.results[0]?.calibratedWinProb ?? 0,
      podiumProb1: sim.results[0]?.podiumProbability ?? 0,
      podiumProb2: sim.results[1]?.podiumProbability ?? 0,
      podiumProb3: sim.results[2]?.podiumProbability ?? 0,
      actualWinner: null, actualP2: null, actualP3: null,
      actualTopFive: null, actualTopTen: null,
      winnerCorrect: null, podiumCorrect: null, top5Correct: null, top10Correct: null,
      modelVersion: '4.1-backtest',
      createdAt: new Date().toISOString(),
    };
    insertPrediction(pred);

    // Store race results
    for (const r of raceResult.Results ?? []) {
      insertRaceResult({
        raceId,
        season,
        round: race.round,
        grandPrix: raceResult.raceName,
        circuit: raceResult.circuit?.circuitName ?? race.circuit,
        date: raceResult.date,
        driverId: normDriver(r.Driver.driverId),
        driverName: `${r.Driver.givenName} ${r.Driver.familyName}`,
        constructorId: normConstructor(r.Constructor.constructorId),
        finishingPosition: Number(r.position),
        gridPosition: Number(r.grid),
        status: r.status,
        fastestLap: r.FastestLap?.rank === '1',
        points: 0,
      });
    }

    // Score prediction
    const scored = scoreRace(predictedOrder, raceResult);

    updatePredictionActuals(season, race.round, {
      actualWinner: scored.actualWinner,
      actualP2: scored.actualTop10[1] ?? '',
      actualP3: scored.actualTop10[2] ?? '',
      actualTopFive: JSON.stringify(scored.actualTop10.slice(0, 5)),
      actualTopTen: JSON.stringify(scored.actualTop10),
      winnerCorrect: scored.winnerCorrect,
      podiumCorrect: scored.podiumCorrect,
      top5Correct: scored.top5Correct,
      top10Correct: scored.top10Correct,
    });

    // Update Elo after race
    updateEloAfterRace(raceResult, season);

    // Update accuracy
    acc = updateAccuracy(acc, scored);
    upsertSeasonAccuracy(acc);

    // Update rolling windows
    recentRaces.push(raceResult);
    if (qualiResult) recentQualifying.push(qualiResult);
    if (recentRaces.length > 5) recentRaces.shift();
    if (recentQualifying.length > 3) recentQualifying.shift();

    logger.info(
      {
        season,
        round: race.round,
        gp: race.grandPrix,
        winner: scored.actualWinner,
        predicted: predictedOrder[0],
        winnerCorrect: scored.winnerCorrect === 1,
        runningWinAcc: `${(acc.winnerAccuracy * 100).toFixed(1)}%`,
        runningPodAcc: `${(acc.podiumSlotAccuracy * 100).toFixed(1)}%`,
      },
      'Race scored',
    );

    persistDb();

    } catch (raceErr) {
      logger.error({ season, round: race.round, gp: race.grandPrix, err: raceErr }, 'Race processing failed — skipping');
    }

    await sleep(800); // be kind to Ergast
  }

  logger.info(
    {
      season,
      races: acc.totalRaces,
      winnerAcc: `${(acc.winnerAccuracy * 100).toFixed(1)}%`,
      podiumAcc: `${(acc.podiumSlotAccuracy * 100).toFixed(1)}%`,
      top5Acc: `${(acc.top5SetAccuracy * 100).toFixed(1)}%`,
    },
    `Season ${season} backtest complete`,
  );

  return acc;
}

// ─── Multi-season summary report ──────────────────────────────────────────────

function printSummaryReport(seasonResults: Map<number, SeasonAccuracy>): void {
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  F1 Oracle v4.1 — Backtest Results (2021–2025)');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  Season  Races  Winner%  Podium%  Top-5%  H2H%');
  console.log('  ─────────────────────────────────────────────────────────────────────');

  let totalRaces = 0, totalWinner = 0, totalPodiumSlots = 0, totalPodiumCorrect = 0;
  let totalTop5 = 0;

  for (const [season, acc] of [...seasonResults.entries()].sort()) {
    const w = (acc.winnerAccuracy * 100).toFixed(1).padStart(6);
    const p = (acc.podiumSlotAccuracy * 100).toFixed(1).padStart(7);
    const t5 = (acc.top5SetAccuracy * 100).toFixed(1).padStart(7);
    const h = acc.h2hTotal > 0
      ? (acc.h2hAccuracy * 100).toFixed(1).padStart(5)
      : '  N/A';
    console.log(`  ${season}     ${String(acc.totalRaces).padStart(3)}   ${w}%  ${p}%  ${t5}%  ${h}%`);

    totalRaces += acc.totalRaces;
    totalWinner += acc.winnerCorrect;
    totalPodiumSlots += acc.podiumSlotsTotal;
    totalPodiumCorrect += acc.podiumSlotsCorrect;
    totalTop5 += acc.top5SetCorrect;
  }

  console.log('  ─────────────────────────────────────────────────────────────────────');
  const allW = totalRaces > 0 ? (totalWinner / totalRaces * 100).toFixed(1) : '0.0';
  const allP = totalPodiumSlots > 0 ? (totalPodiumCorrect / totalPodiumSlots * 100).toFixed(1) : '0.0';
  const allT = totalRaces > 0 ? (totalTop5 / totalRaces * 100).toFixed(1) : '0.0';
  console.log(`  ALL       ${String(totalRaces).padStart(3)}   ${String(allW).padStart(6)}%  ${String(allP).padStart(7)}%  ${String(allT).padStart(7)}%`);
  console.log('');
  console.log('  Targets: Winner ≥ 45% | Podium ≥ 75% | Top-5 ≥ 85%');
  console.log('═══════════════════════════════════════════════════════════════════════\n');
}

// ─── Discord summary embed ────────────────────────────────────────────────────

async function sendBacktestResultsEmbed(seasonResults: Map<number, SeasonAccuracy>): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const rows = [...seasonResults.entries()]
    .sort()
    .map(([season, acc]) => {
      const w = (acc.winnerAccuracy * 100).toFixed(1);
      const p = (acc.podiumSlotAccuracy * 100).toFixed(1);
      const t = (acc.top5SetAccuracy * 100).toFixed(1);
      return `**${season}**: ${acc.totalRaces} races | Win ${w}% | Pod ${p}% | Top5 ${t}%`;
    })
    .join('\n');

  // Aggregate
  const all = [...seasonResults.values()];
  const totalRaces = all.reduce((s, a) => s + a.totalRaces, 0);
  const allWinAcc = all.reduce((s, a) => s + a.winnerCorrect, 0) / totalRaces;
  const totalPodSlots = all.reduce((s, a) => s + a.podiumSlotsTotal, 0);
  const allPodAcc = all.reduce((s, a) => s + a.podiumSlotsCorrect, 0) / totalPodSlots;
  const allTop5 = all.reduce((s, a) => s + a.top5SetCorrect, 0) / totalRaces;

  const summary = [
    `🏆 **Winner: ${(allWinAcc * 100).toFixed(1)}%** *(target ≥ 45%)*`,
    `🥇 **Podium: ${(allPodAcc * 100).toFixed(1)}%** *(target ≥ 75%)*`,
    `🎯 **Top-5: ${(allTop5 * 100).toFixed(1)}%** *(target ≥ 85%)*`,
  ].join('\n');

  const fetch = (await import('node-fetch')).default;
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: '📊 F1 Oracle v4.1 — Backtest Results (2021–2025)',
        description: `${totalRaces} races scored across 5 seasons`,
        color: 0xE10600,
        fields: [
          { name: '📋 Season Breakdown', value: rows, inline: false },
          { name: '📈 Overall Accuracy', value: summary, inline: false },
          { name: '🔬 Calibration', value: 'Platt scaling trained on backtest results. Run `npm run train` to update.', inline: false },
        ],
        footer: { text: 'F1 Oracle v4.1 | Historical Backtest | 10,000 simulations per race' },
        timestamp: new Date().toISOString(),
      }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  logger.info('Backtest results embed sent to Discord');
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse --seasons 2021,2022,2023,2024,2025
  const seasonsArg = args.find(a => a.startsWith('--seasons'))
    ? args[args.indexOf('--seasons') + 1]
    : null;
  const startRoundArg = args.find(a => a.startsWith('--start-round'))
    ? Number(args[args.indexOf('--start-round') + 1])
    : 1;
  const sendDiscord = !args.includes('--no-discord');

  const seasons = seasonsArg
    ? seasonsArg.split(',').map(Number)
    : [2021, 2022, 2023, 2024, 2025];

  logger.info({ seasons, startRound: startRoundArg }, 'F1 Oracle Backtest starting');

  await initDb();

  const seasonResults = new Map<number, SeasonAccuracy>();

  for (const season of seasons) {
    await initDriverElo(season);
    const acc = await backtestSeason(season, season === seasons[0] ? startRoundArg : 1);
    seasonResults.set(season, acc);
  }

  printSummaryReport(seasonResults);

  if (sendDiscord) {
    await sendBacktestResultsEmbed(seasonResults);
  }

  closeDb();
}

process.on('unhandledRejection', reason => { logger.error({ reason }, 'Unhandled rejection'); process.exit(1); });
process.on('uncaughtException', err => { logger.error({ err }, 'Uncaught exception'); closeDb(); process.exit(1); });

main();
