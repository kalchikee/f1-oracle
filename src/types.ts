// F1 Oracle v4.1 — Core Type Definitions

// ─── Constructors & Drivers ───────────────────────────────────────────────────

export interface Constructor {
  id: string;              // e.g. 'red_bull', 'ferrari', 'mercedes'
  name: string;            // e.g. 'Red Bull Racing'
  shortName: string;       // e.g. 'Red Bull'
  color: string;           // hex e.g. '#3671C6'
}

export interface Driver {
  id: string;              // e.g. 'verstappen', 'leclerc'
  name: string;            // e.g. 'Max Verstappen'
  shortName: string;       // e.g. 'VER'
  number: number;          // car number
  constructorId: string;
  nationality: string;
  careerStarts: number;    // total F1 race starts (experience)
}

// ─── Constructor Power Model ──────────────────────────────────────────────────

export interface ConstructorPaceDelta {
  constructorId: string;
  constructorName: string;
  // Pace delta in seconds per lap behind the fastest car (0.000 = fastest)
  qualifyingDelta: number;    // qualifying pace gap (most reliable)
  racePaceDelta: number;      // race pace gap (fuel/tire adjusted)
  blendedDelta: number;       // weighted blend (0.6 quali + 0.4 race)
  circuitDelta: number;       // circuit-specific adjustment (3-yr history)
  finalDelta: number;         // final pace delta used in simulation
  reliabilityRate: number;    // probability of finishing (1 - DNF rate) per race
  pitStopAvg: number;         // average pit stop time in seconds
  upgradeTrajectory: number;  // pace delta change over last 5 races (negative = improving)
  dataSource: 'current' | 'prior_season' | 'blended' | 'preseason';
  confidence: number;         // 0–1 confidence in the estimate
}

// ─── Driver Features ──────────────────────────────────────────────────────────

export interface DriverFeatures {
  driverId: string;
  driverName: string;
  constructorId: string;
  // Elo
  elo: number;
  eloVsTeammate: number;      // Elo delta vs current teammate (positive = faster)
  // Race features
  qualiPosition: number | null;   // actual grid position (null before qualifying)
  qualiToRaceGain: number;        // historical avg positions gained from grid to finish
  wetWeatherRating: number;       // performance delta in wet (positive = better in wet)
  overtakingAbility: number;      // overtakes per race normalized
  tireManagement: number;         // tire preservation score (0–1)
  circuitHistory: number;         // historical finish position avg at this circuit (lower = better)
  experience: number;             // career starts (rookies penalized)
  penaltyFlag: number;            // 1 if grid penalty applied
  sprintResult: number | null;    // sprint finishing position if applicable
  // Teammate gap
  teammateDelta: number;          // qualifying gap to teammate in seconds (negative = faster)
}

// ─── Race Context ─────────────────────────────────────────────────────────────

export interface RaceContext {
  raceId: string;
  season: number;
  round: number;
  totalRounds: number;
  grandPrix: string;           // e.g. 'British Grand Prix'
  circuit: string;             // e.g. 'Silverstone Circuit'
  circuitId: string;           // e.g. 'silverstone'
  country: string;
  date: string;                // YYYY-MM-DD race date
  fp1Date: string | null;
  fp2Date: string | null;
  fp3Date: string | null;
  qualifyingDate: string | null;
  sprintDate: string | null;
  isSprintWeekend: boolean;
  // Circuit characteristics
  circuitType: 'street' | 'high_speed' | 'high_downforce' | 'power' | 'balanced';
  overtakingDifficulty: number;  // 0–1 (0 = easy, 1 = near impossible like Monaco)
  safetyCarProbability: number;  // historical SC probability (0–1)
  tireDegradationRate: 'low' | 'medium' | 'high';
  altitude: number;              // meters (Mexico City ~2240m)
  // Weather
  weather: 'dry' | 'wet' | 'mixed';
  rainProbability: number;       // 0–1
  // Season phase
  seasonPhase: 'preseason' | 'early' | 'blending' | 'full';
  isRegulationChangeYear: boolean;
}

// ─── Simulation Output ────────────────────────────────────────────────────────

export interface DriverSimResult {
  driverId: string;
  driverName: string;
  constructorId: string;
  constructorName: string;
  // Probabilities from simulation
  winProbability: number;         // P(finish 1st)
  podiumProbability: number;      // P(finish top 3)
  top5Probability: number;        // P(finish top 5)
  top10Probability: number;       // P(finish top 10)
  pointsProbability: number;      // P(finish top 10 = points in modern F1)
  fastestLapProbability: number;  // P(set fastest lap)
  dnfProbability: number;         // P(DNF)
  // Expected finishing position
  expectedPosition: number;
  predictedPosition: number;      // rounded expected position
  // Position probability distribution [P(P1), P(P2), ... P(P20)]
  positionDistribution: number[];
  // Calibrated probabilities (after Platt scaling)
  calibratedWinProb: number;
  calibratedPodiumProb: number;
  // H2H vs teammate
  teammateH2HProbability: number; // P(beats teammate)
}

export interface RaceSimulation {
  raceId: string;
  round: number;
  season: number;
  grandPrix: string;
  circuit: string;
  simulations: number;
  simulationMode: 'pre_qualifying' | 'post_qualifying' | 'practice_only';
  results: DriverSimResult[];
  predictedTopTen: string[];      // ordered driver IDs
  safetyCarProb: number;
  wetRaceProb: number;
  createdAt: string;
}

// ─── Predictions (stored in DB) ───────────────────────────────────────────────

export interface RacePrediction {
  id?: number;
  raceId: string;
  season: number;
  round: number;
  grandPrix: string;
  circuit: string;
  simulationMode: 'pre_qualifying' | 'post_qualifying' | 'practice_only';
  // Top 10 predictions (JSON stringified DriverSimResult[])
  driverResults: string;
  predictedWinner: string;
  predictedP2: string;
  predictedP3: string;
  predictedTopFive: string;       // JSON array
  predictedTopTen: string;        // JSON array
  winnerProbability: number;
  podiumProb1: number;
  podiumProb2: number;
  podiumProb3: number;
  // Actuals (filled in post-race)
  actualWinner: string | null;
  actualP2: string | null;
  actualP3: string | null;
  actualTopFive: string | null;
  actualTopTen: string | null;
  // Accuracy flags
  winnerCorrect: number | null;    // 1 if correct, 0 if not
  podiumCorrect: number | null;    // podium positions correct (0-3)
  top5Correct: number | null;
  top10Correct: number | null;
  modelVersion: string;
  createdAt: string;
}

// ─── Elo Ratings ─────────────────────────────────────────────────────────────

export interface DriverElo {
  driverId: string;
  driverName: string;
  rating: number;             // base 1500
  gamesPlayed: number;        // races as basis for Elo
  season: number;
  updatedAt: string;
}

// ─── Accuracy Tracker ────────────────────────────────────────────────────────

export interface SeasonAccuracy {
  season: number;
  totalRaces: number;
  // Winner accuracy
  winnerCorrect: number;
  winnerAccuracy: number;
  // Podium accuracy (per slot)
  podiumSlotsCorrect: number;
  podiumSlotsTotal: number;
  podiumSlotAccuracy: number;
  // Top-5 accuracy (any finisher in top 5)
  top5SetCorrect: number;
  top5SetAccuracy: number;
  // Teammate H2H
  h2hCorrect: number;
  h2hTotal: number;
  h2hAccuracy: number;
  // Value bets P&L (if tracking)
  valueBetsWon: number;
  valueBetsLost: number;
  valueBetsROI: number;
}

// ─── Race Calendar ────────────────────────────────────────────────────────────

export interface F1Race {
  season: number;
  round: number;
  grandPrix: string;
  circuit: string;
  circuitId: string;
  country: string;
  date: string;        // YYYY-MM-DD
  fp1Date: string | null;
  fp2Date: string | null;
  fp3Date: string | null;
  qualifyingDate: string | null;
  sprintDate: string | null;
  sprintQualifyingDate: string | null;
  isSprintWeekend: boolean;
}

// ─── Edge Detection ───────────────────────────────────────────────────────────

export type EdgeCategory = 'none' | 'small' | 'meaningful' | 'large';

export interface DriverEdge {
  driverId: string;
  driverName: string;
  market: 'win' | 'podium' | 'top6' | 'h2h';
  modelProb: number;
  impliedOddsProb: number | null;
  edge: number | null;          // modelProb - impliedOddsProb
  edgeCategory: EdgeCategory;
}

// ─── Pipeline Options ─────────────────────────────────────────────────────────

export interface PipelineOptions {
  season?: number;
  round?: number;
  mode?: 'practice' | 'qualifying' | 'race' | 'preseason';
  forceRefresh?: boolean;
  verbose?: boolean;
  simulations?: number;
}

// ─── Constructor Power History (for blending) ─────────────────────────────────

export interface ConstructorHistory {
  constructorId: string;
  season: number;
  finalDelta: number;         // end-of-season pace delta
  championshipPosition: number;
}

// ─── OpenF1 / Ergast raw types ────────────────────────────────────────────────

export interface ErgastRaceResult {
  season: string;
  round: string;
  raceName: string;
  circuit: { circuitId: string; circuitName: string };
  date: string;
  Results: Array<{
    position: string;
    Driver: { driverId: string; code: string; givenName: string; familyName: string };
    Constructor: { constructorId: string; name: string };
    grid: string;
    laps: string;
    status: string;
    FastestLap?: { rank: string; lap: string; Time: { time: string } };
    Time?: { time: string };
  }>;
}

export interface ErgastQualifyingResult {
  season: string;
  round: string;
  raceName: string;
  circuit: { circuitId: string; circuitName: string };
  date: string;
  QualifyingResults: Array<{
    position: string;
    Driver: { driverId: string; code: string; givenName: string; familyName: string };
    Constructor: { constructorId: string; name: string };
    Q1?: string; Q2?: string; Q3?: string;
  }>;
}

export interface ErgastStanding {
  position: string;
  Driver?: { driverId: string; code: string; givenName: string; familyName: string };
  Constructor?: { constructorId: string; name: string };
  points: string;
  wins: string;
}
