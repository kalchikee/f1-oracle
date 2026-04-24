// Writes today's F1 race prediction to predictions/YYYY-MM-DD.json.
// The kalshi-safety service fetches this file via GitHub raw URL to
// decide which picks to back on Kalshi.
//
// F1 is treated as a single "game" per race weekend:
//   home        = model's favorite (highest calibrated win prob)
//   away        = runner-up (second highest calibrated win prob)
//   pickedTeam  = the favored driver
//   pickedSide  = 'home'
//   modelProb   = calibrated win probability of the favorite

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { RaceSimulation } from '../types.js';

interface Pick {
  gameId: string;
  home: string;
  away: string;
  startTime?: string;
  pickedTeam: string;
  pickedSide: 'home' | 'away';
  modelProb: number;
  vegasProb?: number;
  edge?: number;
  confidenceTier?: string;
  extra?: Record<string, unknown>;
}

interface PredictionsFile {
  sport: 'F1';
  date: string;
  generatedAt: string;
  picks: Pick[];
}

const MIN_PROB = parseFloat(process.env.KALSHI_MIN_PROB ?? '0.58');

function tierFor(prob: number): string {
  if (prob >= 0.55) return 'extreme';
  if (prob >= 0.45) return 'high_conviction';
  if (prob >= 0.35) return 'strong';
  if (prob >= 0.25) return 'lean';
  return 'uncertain';
}

export function writePredictionsFile(date: string, sim: RaceSimulation): string {
  const dir = resolve(process.cwd(), 'predictions');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${date}.json`);

  const picks: Pick[] = [];

  // Sort drivers by calibrated win probability, descending.
  const sorted = [...sim.results].sort(
    (a, b) => b.calibratedWinProb - a.calibratedWinProb,
  );

  if (sorted.length >= 2) {
    const fav = sorted[0];
    const runnerUp = sorted[1];
    const modelProb = fav.calibratedWinProb;

    // F1 win markets are inherently wide-open (modal winner is typically 25-45%).
    // Still respect MIN_PROB so the safety service sees a consistent threshold.
    if (modelProb >= MIN_PROB) {
      picks.push({
        gameId: `f1-${date}-${sim.season}-r${sim.round}`,
        home: fav.driverName,
        away: runnerUp.driverName,
        pickedTeam: fav.driverName,
        pickedSide: 'home',
        modelProb,
        confidenceTier: tierFor(modelProb),
        extra: {
          raceId: sim.raceId,
          season: sim.season,
          round: sim.round,
          grandPrix: sim.grandPrix,
          circuit: sim.circuit,
          favoriteDriverId: fav.driverId,
          favoriteConstructor: fav.constructorName,
          runnerUpDriverId: runnerUp.driverId,
          runnerUpWinProb: runnerUp.calibratedWinProb,
          podiumProb: fav.calibratedPodiumProb,
          simulations: sim.simulations,
        },
      });
    }
  }

  const file: PredictionsFile = {
    sport: 'F1',
    date,
    generatedAt: new Date().toISOString(),
    picks,
  };
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}
