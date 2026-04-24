// F1 Oracle v4.1 — SQLite Database Layer (sql.js — pure JS, no native build)

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  RacePrediction,
  DriverElo,
  SeasonAccuracy,
  ConstructorPaceDelta,
} from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = resolve(
  process.env.DB_PATH
    ? process.env.DB_PATH.startsWith('.')
      ? resolve(__dirname, '../../', process.env.DB_PATH)
      : process.env.DB_PATH
    : resolve(__dirname, '../../data/f1_oracle.db'),
);

mkdirSync(dirname(DB_PATH), { recursive: true });

let _db: SqlJsDatabase | null = null;

// ─── Initialization ───────────────────────────────────────────────────────────

export async function initDb(): Promise<SqlJsDatabase> {
  if (_db) return _db;
  const SQL = await initSqlJs();
  if (existsSync(DB_PATH)) {
    const fileBuffer = readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }
  initializeSchema(_db);
  persistDb();
  return _db;
}

export function getDb(): SqlJsDatabase {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

export function closeDb(): void {
  if (_db) { persistDb(); _db.close(); _db = null; }
}

export function persistDb(): void {
  if (!_db) return;
  const data = _db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

function run(sql: string, params: (string | number | null | undefined)[] = []): void {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.run(params.map(p => (p === undefined ? null : p)));
  stmt.free();
  persistDb();
}

function queryAll<T = Record<string, unknown>>(
  sql: string,
  params: (string | number | null)[] = [],
): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: (string | number | null)[] = [],
): T | undefined {
  return queryAll<T>(sql, params)[0];
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function initializeSchema(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS driver_elo (
      driver_id TEXT PRIMARY KEY,
      driver_name TEXT NOT NULL,
      rating REAL NOT NULL DEFAULT 1500,
      games_played INTEGER NOT NULL DEFAULT 0,
      season INTEGER NOT NULL DEFAULT 2025,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS constructor_pace (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      constructor_id TEXT NOT NULL,
      constructor_name TEXT NOT NULL,
      season INTEGER NOT NULL,
      round INTEGER NOT NULL,
      qualifying_delta REAL NOT NULL DEFAULT 0,
      race_pace_delta REAL NOT NULL DEFAULT 0,
      blended_delta REAL NOT NULL DEFAULT 0,
      circuit_delta REAL NOT NULL DEFAULT 0,
      final_delta REAL NOT NULL DEFAULT 0,
      reliability_rate REAL NOT NULL DEFAULT 0.95,
      pit_stop_avg REAL NOT NULL DEFAULT 2.5,
      upgrade_trajectory REAL NOT NULL DEFAULT 0,
      data_source TEXT NOT NULL DEFAULT 'current',
      confidence REAL NOT NULL DEFAULT 0.8,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(constructor_id, season, round)
    );

    CREATE TABLE IF NOT EXISTS race_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      race_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      round INTEGER NOT NULL,
      grand_prix TEXT NOT NULL,
      circuit TEXT NOT NULL,
      simulation_mode TEXT NOT NULL DEFAULT 'post_qualifying',
      driver_results TEXT NOT NULL,
      predicted_winner TEXT NOT NULL,
      predicted_p2 TEXT NOT NULL,
      predicted_p3 TEXT NOT NULL,
      predicted_top_five TEXT NOT NULL,
      predicted_top_ten TEXT NOT NULL,
      winner_probability REAL NOT NULL DEFAULT 0,
      podium_prob_1 REAL NOT NULL DEFAULT 0,
      podium_prob_2 REAL NOT NULL DEFAULT 0,
      podium_prob_3 REAL NOT NULL DEFAULT 0,
      actual_winner TEXT,
      actual_p2 TEXT,
      actual_p3 TEXT,
      actual_top_five TEXT,
      actual_top_ten TEXT,
      winner_correct INTEGER,
      podium_correct INTEGER,
      top5_correct INTEGER,
      top10_correct INTEGER,
      model_version TEXT NOT NULL DEFAULT '4.1',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS race_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      race_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      round INTEGER NOT NULL,
      grand_prix TEXT NOT NULL,
      circuit TEXT NOT NULL,
      date TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      driver_name TEXT NOT NULL,
      constructor_id TEXT NOT NULL,
      finishing_position INTEGER NOT NULL,
      grid_position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Finished',
      fastest_lap INTEGER NOT NULL DEFAULT 0,
      points REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(race_id, driver_id)
    );

    CREATE TABLE IF NOT EXISTS season_accuracy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season INTEGER NOT NULL UNIQUE,
      total_races INTEGER NOT NULL DEFAULT 0,
      winner_correct INTEGER NOT NULL DEFAULT 0,
      winner_accuracy REAL NOT NULL DEFAULT 0,
      podium_slots_correct INTEGER NOT NULL DEFAULT 0,
      podium_slots_total INTEGER NOT NULL DEFAULT 0,
      podium_slot_accuracy REAL NOT NULL DEFAULT 0,
      top5_set_correct INTEGER NOT NULL DEFAULT 0,
      top5_set_accuracy REAL NOT NULL DEFAULT 0,
      h2h_correct INTEGER NOT NULL DEFAULT 0,
      h2h_total INTEGER NOT NULL DEFAULT 0,
      h2h_accuracy REAL NOT NULL DEFAULT 0,
      value_bets_won INTEGER NOT NULL DEFAULT 0,
      value_bets_lost INTEGER NOT NULL DEFAULT 0,
      value_bets_roi REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ─── Driver Elo ───────────────────────────────────────────────────────────────

export function upsertDriverElo(elo: DriverElo): void {
  run(
    `INSERT INTO driver_elo (driver_id, driver_name, rating, games_played, season, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(driver_id) DO UPDATE SET
       driver_name = excluded.driver_name,
       rating = excluded.rating,
       games_played = excluded.games_played,
       season = excluded.season,
       updated_at = excluded.updated_at`,
    [elo.driverId, elo.driverName, elo.rating, elo.gamesPlayed, elo.season, elo.updatedAt],
  );
}

export function getDriverElo(driverId: string): DriverElo | null {
  const row = queryOne<{
    driver_id: string; driver_name: string; rating: number;
    games_played: number; season: number; updated_at: string;
  }>('SELECT * FROM driver_elo WHERE driver_id = ?', [driverId]);
  if (!row) return null;
  return {
    driverId: row.driver_id,
    driverName: row.driver_name,
    rating: row.rating,
    gamesPlayed: row.games_played,
    season: row.season,
    updatedAt: row.updated_at,
  };
}

export function getAllDriverElo(): DriverElo[] {
  return queryAll<{
    driver_id: string; driver_name: string; rating: number;
    games_played: number; season: number; updated_at: string;
  }>('SELECT * FROM driver_elo ORDER BY rating DESC').map(row => ({
    driverId: row.driver_id,
    driverName: row.driver_name,
    rating: row.rating,
    gamesPlayed: row.games_played,
    season: row.season,
    updatedAt: row.updated_at,
  }));
}

// ─── Constructor Pace ─────────────────────────────────────────────────────────

export function upsertConstructorPace(pace: ConstructorPaceDelta, season: number, round: number): void {
  run(
    `INSERT INTO constructor_pace
       (constructor_id, constructor_name, season, round, qualifying_delta, race_pace_delta,
        blended_delta, circuit_delta, final_delta, reliability_rate, pit_stop_avg,
        upgrade_trajectory, data_source, confidence, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(constructor_id, season, round) DO UPDATE SET
       qualifying_delta = excluded.qualifying_delta,
       race_pace_delta = excluded.race_pace_delta,
       blended_delta = excluded.blended_delta,
       circuit_delta = excluded.circuit_delta,
       final_delta = excluded.final_delta,
       reliability_rate = excluded.reliability_rate,
       pit_stop_avg = excluded.pit_stop_avg,
       upgrade_trajectory = excluded.upgrade_trajectory,
       data_source = excluded.data_source,
       confidence = excluded.confidence,
       updated_at = excluded.updated_at`,
    [
      pace.constructorId, pace.constructorName, season, round,
      pace.qualifyingDelta, pace.racePaceDelta, pace.blendedDelta,
      pace.circuitDelta, pace.finalDelta, pace.reliabilityRate,
      pace.pitStopAvg, pace.upgradeTrajectory, pace.dataSource,
      pace.confidence, new Date().toISOString(),
    ],
  );
}

export function getLatestConstructorPace(season: number, round: number): ConstructorPaceDelta[] {
  return queryAll<{
    constructor_id: string; constructor_name: string;
    qualifying_delta: number; race_pace_delta: number; blended_delta: number;
    circuit_delta: number; final_delta: number; reliability_rate: number;
    pit_stop_avg: number; upgrade_trajectory: number; data_source: string; confidence: number;
  }>(
    `SELECT * FROM constructor_pace WHERE season = ? AND round = ? ORDER BY final_delta ASC`,
    [season, round],
  ).map(row => ({
    constructorId: row.constructor_id,
    constructorName: row.constructor_name,
    qualifyingDelta: row.qualifying_delta,
    racePaceDelta: row.race_pace_delta,
    blendedDelta: row.blended_delta,
    circuitDelta: row.circuit_delta,
    finalDelta: row.final_delta,
    reliabilityRate: row.reliability_rate,
    pitStopAvg: row.pit_stop_avg,
    upgradeTrajectory: row.upgrade_trajectory,
    dataSource: row.data_source as ConstructorPaceDelta['dataSource'],
    confidence: row.confidence,
  }));
}

// ─── Predictions ──────────────────────────────────────────────────────────────

export function insertPrediction(pred: RacePrediction): number {
  const db = getDb();
  db.run(
    `INSERT INTO race_predictions
       (race_id, season, round, grand_prix, circuit, simulation_mode, driver_results,
        predicted_winner, predicted_p2, predicted_p3, predicted_top_five, predicted_top_ten,
        winner_probability, podium_prob_1, podium_prob_2, podium_prob_3, model_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pred.raceId, pred.season, pred.round, pred.grandPrix, pred.circuit,
      pred.simulationMode, pred.driverResults,
      pred.predictedWinner, pred.predictedP2, pred.predictedP3,
      pred.predictedTopFive, pred.predictedTopTen,
      pred.winnerProbability, pred.podiumProb1, pred.podiumProb2, pred.podiumProb3,
      pred.modelVersion, pred.createdAt,
    ],
  );
  persistDb();
  const result = queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
  return result?.id ?? 0;
}

export function getPredictionByRound(season: number, round: number, mode?: string): RacePrediction | null {
  const sql = mode
    ? `SELECT * FROM race_predictions WHERE season = ? AND round = ? AND simulation_mode = ? ORDER BY created_at DESC LIMIT 1`
    : `SELECT * FROM race_predictions WHERE season = ? AND round = ? ORDER BY created_at DESC LIMIT 1`;
  const params: (string | number)[] = mode ? [season, round, mode] : [season, round];
  const row = queryOne<Record<string, unknown>>(sql, params);
  if (!row) return null;
  return mapPredictionRow(row);
}

export function updatePredictionActuals(
  season: number,
  round: number,
  actuals: {
    actualWinner: string; actualP2: string; actualP3: string;
    actualTopFive: string; actualTopTen: string;
    winnerCorrect: number; podiumCorrect: number;
    top5Correct: number; top10Correct: number;
  },
): void {
  run(
    `UPDATE race_predictions SET
       actual_winner = ?, actual_p2 = ?, actual_p3 = ?,
       actual_top_five = ?, actual_top_ten = ?,
       winner_correct = ?, podium_correct = ?,
       top5_correct = ?, top10_correct = ?
     WHERE season = ? AND round = ?`,
    [
      actuals.actualWinner, actuals.actualP2, actuals.actualP3,
      actuals.actualTopFive, actuals.actualTopTen,
      actuals.winnerCorrect, actuals.podiumCorrect,
      actuals.top5Correct, actuals.top10Correct,
      season, round,
    ],
  );
}

function mapPredictionRow(row: Record<string, unknown>): RacePrediction {
  return {
    id: row['id'] as number,
    raceId: row['race_id'] as string,
    season: row['season'] as number,
    round: row['round'] as number,
    grandPrix: row['grand_prix'] as string,
    circuit: row['circuit'] as string,
    simulationMode: row['simulation_mode'] as RacePrediction['simulationMode'],
    driverResults: row['driver_results'] as string,
    predictedWinner: row['predicted_winner'] as string,
    predictedP2: row['predicted_p2'] as string,
    predictedP3: row['predicted_p3'] as string,
    predictedTopFive: row['predicted_top_five'] as string,
    predictedTopTen: row['predicted_top_ten'] as string,
    winnerProbability: row['winner_probability'] as number,
    podiumProb1: row['podium_prob_1'] as number,
    podiumProb2: row['podium_prob_2'] as number,
    podiumProb3: row['podium_prob_3'] as number,
    actualWinner: row['actual_winner'] as string | null,
    actualP2: row['actual_p2'] as string | null,
    actualP3: row['actual_p3'] as string | null,
    actualTopFive: row['actual_top_five'] as string | null,
    actualTopTen: row['actual_top_ten'] as string | null,
    winnerCorrect: row['winner_correct'] as number | null,
    podiumCorrect: row['podium_correct'] as number | null,
    top5Correct: row['top5_correct'] as number | null,
    top10Correct: row['top10_correct'] as number | null,
    modelVersion: row['model_version'] as string,
    createdAt: row['created_at'] as string,
  };
}

// ─── Race Results ─────────────────────────────────────────────────────────────

export function insertRaceResult(result: {
  raceId: string; season: number; round: number; grandPrix: string;
  circuit: string; date: string; driverId: string; driverName: string;
  constructorId: string; finishingPosition: number; gridPosition: number;
  status: string; fastestLap: boolean; points: number;
}): void {
  run(
    `INSERT OR REPLACE INTO race_results
       (race_id, season, round, grand_prix, circuit, date, driver_id, driver_name,
        constructor_id, finishing_position, grid_position, status, fastest_lap, points, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      result.raceId, result.season, result.round, result.grandPrix, result.circuit,
      result.date, result.driverId, result.driverName, result.constructorId,
      result.finishingPosition, result.gridPosition, result.status,
      result.fastestLap ? 1 : 0, result.points, new Date().toISOString(),
    ],
  );
}

export function getRaceResults(season: number, round: number): Array<{
  driverId: string; driverName: string; constructorId: string;
  finishingPosition: number; gridPosition: number; status: string; fastestLap: boolean;
}> {
  return queryAll<{
    driver_id: string; driver_name: string; constructor_id: string;
    finishing_position: number; grid_position: number; status: string; fastest_lap: number;
  }>(
    'SELECT * FROM race_results WHERE season = ? AND round = ? ORDER BY finishing_position',
    [season, round],
  ).map(r => ({
    driverId: r.driver_id,
    driverName: r.driver_name,
    constructorId: r.constructor_id,
    finishingPosition: r.finishing_position,
    gridPosition: r.grid_position,
    status: r.status,
    fastestLap: r.fastest_lap === 1,
  }));
}

// ─── Season Accuracy ──────────────────────────────────────────────────────────

export function upsertSeasonAccuracy(acc: SeasonAccuracy): void {
  run(
    `INSERT INTO season_accuracy
       (season, total_races, winner_correct, winner_accuracy, podium_slots_correct,
        podium_slots_total, podium_slot_accuracy, top5_set_correct, top5_set_accuracy,
        h2h_correct, h2h_total, h2h_accuracy, value_bets_won, value_bets_lost,
        value_bets_roi, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(season) DO UPDATE SET
       total_races = excluded.total_races,
       winner_correct = excluded.winner_correct,
       winner_accuracy = excluded.winner_accuracy,
       podium_slots_correct = excluded.podium_slots_correct,
       podium_slots_total = excluded.podium_slots_total,
       podium_slot_accuracy = excluded.podium_slot_accuracy,
       top5_set_correct = excluded.top5_set_correct,
       top5_set_accuracy = excluded.top5_set_accuracy,
       h2h_correct = excluded.h2h_correct,
       h2h_total = excluded.h2h_total,
       h2h_accuracy = excluded.h2h_accuracy,
       value_bets_won = excluded.value_bets_won,
       value_bets_lost = excluded.value_bets_lost,
       value_bets_roi = excluded.value_bets_roi,
       updated_at = excluded.updated_at`,
    [
      acc.season, acc.totalRaces, acc.winnerCorrect, acc.winnerAccuracy,
      acc.podiumSlotsCorrect, acc.podiumSlotsTotal, acc.podiumSlotAccuracy,
      acc.top5SetCorrect, acc.top5SetAccuracy,
      acc.h2hCorrect, acc.h2hTotal, acc.h2hAccuracy,
      acc.valueBetsWon, acc.valueBetsLost, acc.valueBetsROI,
      new Date().toISOString(),
    ],
  );
}

export function getSeasonAccuracy(season: number): SeasonAccuracy | null {
  const row = queryOne<Record<string, number>>(
    'SELECT * FROM season_accuracy WHERE season = ?', [season],
  );
  if (!row) return null;
  return {
    season: row['season'],
    totalRaces: row['total_races'],
    winnerCorrect: row['winner_correct'],
    winnerAccuracy: row['winner_accuracy'],
    podiumSlotsCorrect: row['podium_slots_correct'],
    podiumSlotsTotal: row['podium_slots_total'],
    podiumSlotAccuracy: row['podium_slot_accuracy'],
    top5SetCorrect: row['top5_set_correct'],
    top5SetAccuracy: row['top5_set_accuracy'],
    h2hCorrect: row['h2h_correct'],
    h2hTotal: row['h2h_total'],
    h2hAccuracy: row['h2h_accuracy'],
    valueBetsWon: row['value_bets_won'],
    valueBetsLost: row['value_bets_lost'],
    valueBetsROI: row['value_bets_roi'],
  };
}
