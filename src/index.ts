// F1 Oracle v4.1 — CLI Entry Point
// Usage:
//   npm start                             → predictions for next race (post-qualifying mode)
//   npm start -- --round 5               → specific round
//   npm start -- --alert practice        → send Friday post-practice embed
//   npm start -- --alert qualifying      → send Saturday post-qualifying embed
//   npm start -- --alert recap           → send Sunday post-race recap
//   npm start -- --alert preseason       → send preseason setup embed
//   npm start -- --help                  → show help

import 'dotenv/config';
import { logger } from './logger.js';
import { runPipeline } from './pipeline.js';
import { initDb, closeDb, getSeasonAccuracy } from './db/database.js';
import { getCurrentF1Season, isF1Season, getRaceCalendar, getCurrentRaceRound } from './api/f1Client.js';
import type { PipelineOptions } from './types.js';

type AlertMode = 'practice' | 'qualifying' | 'recap' | 'preseason' | null;

function parseArgs(): PipelineOptions & { help: boolean; alertMode: AlertMode } {
  const args = process.argv.slice(2);
  const opts: PipelineOptions & { help: boolean; alertMode: AlertMode } = {
    help: false,
    verbose: true,
    forceRefresh: false,
    alertMode: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help': case '-h': opts.help = true; break;
      case '--round': case '-r': opts.round = Number(args[++i]); break;
      case '--season': case '-s': opts.season = Number(args[++i]); break;
      case '--sims': opts.simulations = Number(args[++i]); break;
      case '--force-refresh': case '-f': opts.forceRefresh = true; break;
      case '--quiet': case '-q': opts.verbose = false; break;
      case '--alert': case '-a': {
        const mode = args[++i];
        if (mode === 'practice' || mode === 'qualifying' || mode === 'recap' || mode === 'preseason') {
          opts.alertMode = mode;
        } else {
          console.error(`Unknown alert mode: "${mode}". Use practice|qualifying|recap|preseason`);
          process.exit(1);
        }
        break;
      }
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`
F1 Oracle v4.1 — ML Prediction Engine
======================================

USAGE:
  npm start [options]

OPTIONS:
  --round, -r N             Run predictions for specific round (default: next race)
  --season, -s YYYY         Season year (default: current)
  --sims N                  Number of Monte Carlo simulations (default: 10000)
  --force-refresh, -f       Bypass cache and re-fetch all data
  --quiet, -q               Suppress table output
  --alert, -a MODE          Send Discord embed (practice|qualifying|recap|preseason)
  --help, -h                Show this help

EXAMPLES:
  npm start                              # Next race predictions
  npm start -- --round 5                # Round 5 predictions
  npm run alerts:qualifying              # Post-qualifying Discord embed (Saturday)
  npm run alerts:recap                   # Post-race recap Discord embed (Sunday)
  npm run alerts:practice                # Post-practice Discord embed (Friday)
  npm run alerts:preseason               # Preseason setup Discord embed
  npm run fetch-data                     # Fetch FastF1 data (Python)
  npm run train                          # Train calibration model (Python)

ENVIRONMENT (.env):
  DISCORD_WEBHOOK_URL    Discord webhook URL (required for alerts)
  LOG_LEVEL              Logging level (default: info)

ARCHITECTURE:
  Ergast API + OpenF1 → Constructor Power Model (pace deltas) →
  Driver Elo (teammate comparison) → Race Simulation (10k) →
  Platt Calibration → SQLite → Discord Embeds

ACCURACY TARGETS:
  Race Winner:   45–50%
  Podium:        75–80% (per slot)
  Top-5:         85–90%
  Teammate H2H:  70–75%
`);
}

// ─── Alert handlers ───────────────────────────────────────────────────────────

async function runPracticeAlert(season: number, round: number): Promise<void> {
  const { sendPostPracticeEmbed } = await import('./alerts/discord.js');
  const { CIRCUIT_PROFILES } = await import('./features/circuitProfiles.js');

  let sim = await runPipeline({ season, round, mode: 'practice', verbose: false });
  if (!sim) { logger.warn('No simulation produced — cannot send practice embed'); return; }

  const calendar = await getRaceCalendar(season);
  const race = calendar.find(r => r.round === round);
  if (!race) return;

  // Build minimal context for embed
  const profile = CIRCUIT_PROFILES[race.circuitId] ?? CIRCUIT_PROFILES['default'];
  const context = {
    raceId: `${season}_${round}`,
    season, round,
    totalRounds: calendar.length,
    grandPrix: race.grandPrix,
    circuit: race.circuit,
    circuitId: race.circuitId,
    country: race.circuitId,
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
    weather: 'dry' as const,
    rainProbability: profile.rainProbability ?? 0.10,
    seasonPhase: round <= 3 ? 'early' as const : 'full' as const,
    isRegulationChangeYear: season === 2026,
  };

  const seasonAcc = getSeasonAccuracy(season);
  await sendPostPracticeEmbed(sim, context, seasonAcc);
}

async function runQualifyingAlert(season: number, round: number): Promise<void> {
  const { sendPostQualifyingEmbed } = await import('./alerts/discord.js');
  const { CIRCUIT_PROFILES } = await import('./features/circuitProfiles.js');
  const { getQualifyingResult } = await import('./api/f1Client.js');
  const { writePredictionsFile } = await import('./kalshi/predictionsFile.js');

  const sim = await runPipeline({ season, round, mode: 'qualifying', verbose: false });
  if (!sim) { logger.warn('No simulation produced — cannot send qualifying embed'); return; }

  // Write predictions JSON for kalshi-safety to consume.
  try {
    const date = new Date().toISOString().slice(0, 10);
    const path = writePredictionsFile(date, sim);
    logger.info({ path, season, round }, 'Wrote predictions JSON');
  } catch (err) {
    logger.warn({ err }, 'Failed to write predictions JSON (non-fatal)');
  }

  const calendar = await getRaceCalendar(season);
  const race = calendar.find(r => r.round === round);
  if (!race) return;

  const profile = CIRCUIT_PROFILES[race.circuitId] ?? CIRCUIT_PROFILES['default'];
  const context = {
    raceId: `${season}_${round}`,
    season, round,
    totalRounds: calendar.length,
    grandPrix: race.grandPrix,
    circuit: race.circuit,
    circuitId: race.circuitId,
    country: race.circuitId,
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
    weather: 'dry' as const,
    rainProbability: profile.rainProbability ?? 0.10,
    seasonPhase: round <= 3 ? 'early' as const : 'full' as const,
    isRegulationChangeYear: season === 2026,
  };

  // Build driver features with qualifying positions
  const qualiResult = await getQualifyingResult(season, round);
  const driverFeatures = (qualiResult?.QualifyingResults ?? []).map(qr => ({
    driverId: qr.Driver.driverId,
    qualiPosition: Number(qr.position),
    teammateDelta: 0,
  }));

  const seasonAcc = getSeasonAccuracy(season);
  await sendPostQualifyingEmbed(sim, context, driverFeatures, seasonAcc);
}

async function runRecapAlert(season: number, round: number): Promise<void> {
  const { sendPostRaceRecap } = await import('./alerts/discord.js');
  const { CIRCUIT_PROFILES } = await import('./features/circuitProfiles.js');
  const { getRaceResult, getDriverStandings, CONSTRUCTORS_2026 } = await import('./api/f1Client.js');
  const { getPredictionByRound } = await import('./db/database.js');

  // Score the race and update DB
  const sim = await runPipeline({ season, round, mode: 'race', verbose: false });
  if (!sim) { logger.warn('No simulation produced for recap'); return; }

  const raceResult = await getRaceResult(season, round);
  if (!raceResult) { logger.warn('Race result not available'); return; }

  const topTen = (raceResult.Results ?? [])
    .sort((a, b) => Number(a.position) - Number(b.position))
    .slice(0, 10);

  const actuals = {
    winner: topTen[0] ? `${topTen[0].Driver.givenName} ${topTen[0].Driver.familyName}` : '?',
    p2: topTen[1] ? `${topTen[1].Driver.givenName} ${topTen[1].Driver.familyName}` : '?',
    p3: topTen[2] ? `${topTen[2].Driver.givenName} ${topTen[2].Driver.familyName}` : '?',
    topFive: topTen.slice(0, 5).map(r => `${r.Driver.givenName} ${r.Driver.familyName}`),
    topTen: topTen.map(r => `${r.Driver.givenName} ${r.Driver.familyName}`),
    fastestLap: raceResult.Results?.find(r => r.FastestLap?.rank === '1')
      ? `${raceResult.Results.find(r => r.FastestLap?.rank === '1')!.Driver.givenName} ${raceResult.Results.find(r => r.FastestLap?.rank === '1')!.Driver.familyName}`
      : '?',
  };

  const calendar = await getRaceCalendar(season);
  const race = calendar.find(r => r.round === round);
  if (!race) return;

  const profile = CIRCUIT_PROFILES[race.circuitId] ?? CIRCUIT_PROFILES['default'];
  const context = {
    raceId: `${season}_${round}`,
    season, round,
    totalRounds: calendar.length,
    grandPrix: race.grandPrix,
    circuit: race.circuit,
    circuitId: race.circuitId,
    country: race.circuitId,
    date: race.date,
    fp1Date: null, fp2Date: null, fp3Date: null,
    qualifyingDate: null, sprintDate: null,
    isSprintWeekend: race.isSprintWeekend,
    circuitType: profile.type,
    overtakingDifficulty: profile.overtakingDifficulty,
    safetyCarProbability: profile.safetyCarProbability,
    tireDegradationRate: profile.tireDegradationRate,
    altitude: profile.altitude ?? 0,
    weather: 'dry' as const,
    rainProbability: profile.rainProbability ?? 0.10,
    seasonPhase: 'full' as const,
    isRegulationChangeYear: season === 2026,
  };

  const seasonAcc = getSeasonAccuracy(season) ?? {
    season, totalRaces: 1, winnerCorrect: 0, winnerAccuracy: 0,
    podiumSlotsCorrect: 0, podiumSlotsTotal: 3, podiumSlotAccuracy: 0,
    top5SetCorrect: 0, top5SetAccuracy: 0, h2hCorrect: 0, h2hTotal: 0,
    h2hAccuracy: 0, valueBetsWon: 0, valueBetsLost: 0, valueBetsROI: 0,
  };

  // Driver standings
  const standings = await getDriverStandings(season);
  const driverStandings = standings.slice(0, 5).map(s => ({
    driverName: s.Driver ? `${s.Driver.givenName} ${s.Driver.familyName}` : '?',
    points: Number(s.points),
    position: Number(s.position),
  }));

  await sendPostRaceRecap(sim, actuals, context, seasonAcc, driverStandings);
}

async function runPreseasonAlert(season: number): Promise<void> {
  const { sendPreseasonEmbed } = await import('./alerts/discord.js');
  const { buildConstructorPowerModel } = await import('./features/constructorPower.js');
  const { CIRCUIT_PROFILES } = await import('./features/circuitProfiles.js');

  const calendar = await getRaceCalendar(season);
  const constructorModel = buildConstructorPowerModel({
    season,
    round: 0,
    recentQualifying: [],
    recentRaces: [],
    context: {
      raceId: `${season}_0`,
      season, round: 0, totalRounds: calendar.length,
      grandPrix: 'Preseason', circuit: '', circuitId: 'default',
      country: '', date: '', fp1Date: null, fp2Date: null, fp3Date: null,
      qualifyingDate: null, sprintDate: null, isSprintWeekend: false,
      circuitType: 'balanced', overtakingDifficulty: 0.45,
      safetyCarProbability: 0.40, tireDegradationRate: 'medium',
      altitude: 0, weather: 'dry', rainProbability: 0.10,
      seasonPhase: 'preseason', isRegulationChangeYear: season === 2026,
    },
  });

  await sendPreseasonEmbed(
    season,
    constructorModel.map(c => ({
      constructorName: c.constructorId,
      finalDelta: c.finalDelta,
      dataSource: c.dataSource,
    })),
    calendar.length,
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  if (opts.help) { printHelp(); process.exit(0); }

  if (!isF1Season() && !opts.round && !opts.alertMode) {
    logger.info('F1 season is currently dormant (December–February). Use --round to force.');
    process.exit(0);
  }

  const season = opts.season ?? getCurrentF1Season();
  const calendar = await getRaceCalendar(season);
  const nextRace = getCurrentRaceRound(calendar);
  const round = opts.round ?? nextRace?.round ?? 1;

  await initDb();

  logger.info({ season, round, alert: opts.alertMode ?? 'pipeline' }, 'F1 Oracle starting');

  try {
    switch (opts.alertMode) {
      case 'practice':
        await runPracticeAlert(season, round);
        break;
      case 'qualifying':
        await runQualifyingAlert(season, round);
        break;
      case 'recap':
        await runRecapAlert(season, round);
        break;
      case 'preseason':
        await runPreseasonAlert(season);
        break;
      default: {
        // Regular pipeline run
        if (opts.forceRefresh) {
          const { readdirSync, unlinkSync } = await import('fs');
          const cacheDir = './cache';
          try {
            for (const file of readdirSync(cacheDir)) {
              if (file.endsWith('.json')) unlinkSync(`${cacheDir}/${file}`);
            }
            logger.info('Cache cleared');
          } catch { /* may not exist */ }
        }
        const sim = await runPipeline({ season, round, mode: 'qualifying', verbose: opts.verbose });
        if (!sim) { console.log(`\nNo race data available for Round ${round}, ${season}.\n`); }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Fatal error');
    process.exit(1);
  } finally {
    closeDb();
  }
}

process.on('unhandledRejection', reason => {
  logger.error({ reason }, 'Unhandled rejection');
  process.exit(1);
});
process.on('uncaughtException', err => {
  logger.error({ err }, 'Uncaught exception');
  closeDb();
  process.exit(1);
});

main();
