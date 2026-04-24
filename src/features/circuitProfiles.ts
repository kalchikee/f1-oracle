// F1 Oracle v4.1 — Circuit Profiles
// Circuit-specific characteristics for all 2026 calendar circuits.

import type { RaceContext } from '../types.js';

export interface CircuitProfile {
  type: RaceContext['circuitType'];
  overtakingDifficulty: number;   // 0 = easy, 1 = near impossible
  safetyCarProbability: number;   // historical SC probability
  tireDegradationRate: RaceContext['tireDegradationRate'];
  altitude?: number;              // meters above sea level
  rainProbability?: number;       // historical race rain probability
}

// Keyed by Ergast circuit ID
export const CIRCUIT_PROFILES: Record<string, CircuitProfile> = {
  // ── Australia ────────────────────────────────────────────────────────────────
  albert_park: {
    type: 'street',
    overtakingDifficulty: 0.65,
    safetyCarProbability: 0.55,
    tireDegradationRate: 'medium',
    altitude: 10,
    rainProbability: 0.20,
  },

  // ── Bahrain ──────────────────────────────────────────────────────────────────
  bahrain: {
    type: 'balanced',
    overtakingDifficulty: 0.35,
    safetyCarProbability: 0.40,
    tireDegradationRate: 'high',
    altitude: 7,
    rainProbability: 0.05,
  },

  // ── Saudi Arabia ─────────────────────────────────────────────────────────────
  jeddah: {
    type: 'street',
    overtakingDifficulty: 0.55,
    safetyCarProbability: 0.65,
    tireDegradationRate: 'low',
    altitude: 15,
    rainProbability: 0.03,
  },

  // ── Japan ────────────────────────────────────────────────────────────────────
  suzuka: {
    type: 'high_speed',
    overtakingDifficulty: 0.55,
    safetyCarProbability: 0.40,
    tireDegradationRate: 'medium',
    altitude: 45,
    rainProbability: 0.25,
  },

  // ── China ────────────────────────────────────────────────────────────────────
  shanghai: {
    type: 'balanced',
    overtakingDifficulty: 0.40,
    safetyCarProbability: 0.35,
    tireDegradationRate: 'medium',
    altitude: 5,
    rainProbability: 0.20,
  },

  // ── Miami ────────────────────────────────────────────────────────────────────
  miami: {
    type: 'street',
    overtakingDifficulty: 0.45,
    safetyCarProbability: 0.55,
    tireDegradationRate: 'medium',
    altitude: 2,
    rainProbability: 0.30,
  },

  // ── Imola (Emilia Romagna) ───────────────────────────────────────────────────
  imola: {
    type: 'high_downforce',
    overtakingDifficulty: 0.65,
    safetyCarProbability: 0.45,
    tireDegradationRate: 'medium',
    altitude: 40,
    rainProbability: 0.25,
  },

  // ── Monaco ───────────────────────────────────────────────────────────────────
  monaco: {
    type: 'street',
    overtakingDifficulty: 0.95,
    safetyCarProbability: 0.70,
    tireDegradationRate: 'low',
    altitude: 13,
    rainProbability: 0.20,
  },

  // ── Spain ────────────────────────────────────────────────────────────────────
  catalunya: {
    type: 'balanced',
    overtakingDifficulty: 0.55,
    safetyCarProbability: 0.30,
    tireDegradationRate: 'high',
    altitude: 115,
    rainProbability: 0.10,
  },

  // ── Canada ───────────────────────────────────────────────────────────────────
  villeneuve: {
    type: 'street',
    overtakingDifficulty: 0.40,
    safetyCarProbability: 0.65,
    tireDegradationRate: 'medium',
    altitude: 24,
    rainProbability: 0.30,
  },

  // ── Austria ──────────────────────────────────────────────────────────────────
  red_bull_ring: {
    type: 'balanced',
    overtakingDifficulty: 0.30,
    safetyCarProbability: 0.40,
    tireDegradationRate: 'high',
    altitude: 693,
    rainProbability: 0.25,
  },

  // ── UK (Silverstone) ─────────────────────────────────────────────────────────
  silverstone: {
    type: 'high_speed',
    overtakingDifficulty: 0.40,
    safetyCarProbability: 0.35,
    tireDegradationRate: 'high',
    altitude: 153,
    rainProbability: 0.35,
  },

  // ── Hungary ──────────────────────────────────────────────────────────────────
  hungaroring: {
    type: 'high_downforce',
    overtakingDifficulty: 0.65,
    safetyCarProbability: 0.30,
    tireDegradationRate: 'medium',
    altitude: 264,
    rainProbability: 0.25,
  },

  // ── Belgium (Spa) ────────────────────────────────────────────────────────────
  spa: {
    type: 'power',
    overtakingDifficulty: 0.30,
    safetyCarProbability: 0.55,
    tireDegradationRate: 'medium',
    altitude: 401,
    rainProbability: 0.50,
  },

  // ── Netherlands (Zandvoort) ──────────────────────────────────────────────────
  zandvoort: {
    type: 'high_downforce',
    overtakingDifficulty: 0.75,
    safetyCarProbability: 0.40,
    tireDegradationRate: 'high',
    altitude: 15,
    rainProbability: 0.25,
  },

  // ── Italy (Monza) ────────────────────────────────────────────────────────────
  monza: {
    type: 'power',
    overtakingDifficulty: 0.35,
    safetyCarProbability: 0.45,
    tireDegradationRate: 'low',
    altitude: 162,
    rainProbability: 0.20,
  },

  // ── Azerbaijan (Baku) ────────────────────────────────────────────────────────
  baku: {
    type: 'street',
    overtakingDifficulty: 0.40,
    safetyCarProbability: 0.75,
    tireDegradationRate: 'low',
    altitude: 0,
    rainProbability: 0.05,
  },

  // ── Singapore ────────────────────────────────────────────────────────────────
  marina_bay: {
    type: 'street',
    overtakingDifficulty: 0.80,
    safetyCarProbability: 0.85,
    tireDegradationRate: 'medium',
    altitude: 15,
    rainProbability: 0.40,
  },

  // ── USA (Austin) ─────────────────────────────────────────────────────────────
  americas: {
    type: 'balanced',
    overtakingDifficulty: 0.35,
    safetyCarProbability: 0.45,
    tireDegradationRate: 'high',
    altitude: 152,
    rainProbability: 0.15,
  },

  // ── Mexico ───────────────────────────────────────────────────────────────────
  rodriguez: {
    type: 'power',
    overtakingDifficulty: 0.35,
    safetyCarProbability: 0.40,
    tireDegradationRate: 'low',
    altitude: 2285,
    rainProbability: 0.10,
  },

  // ── Brazil (Interlagos) ──────────────────────────────────────────────────────
  interlagos: {
    type: 'balanced',
    overtakingDifficulty: 0.35,
    safetyCarProbability: 0.50,
    tireDegradationRate: 'medium',
    altitude: 770,
    rainProbability: 0.45,
  },

  // ── Las Vegas ────────────────────────────────────────────────────────────────
  vegas: {
    type: 'power',
    overtakingDifficulty: 0.40,
    safetyCarProbability: 0.60,
    tireDegradationRate: 'low',
    altitude: 620,
    rainProbability: 0.05,
  },

  // ── Qatar ────────────────────────────────────────────────────────────────────
  losail: {
    type: 'high_speed',
    overtakingDifficulty: 0.35,
    safetyCarProbability: 0.30,
    tireDegradationRate: 'high',
    altitude: 15,
    rainProbability: 0.05,
  },

  // ── Abu Dhabi ────────────────────────────────────────────────────────────────
  yas_marina: {
    type: 'balanced',
    overtakingDifficulty: 0.45,
    safetyCarProbability: 0.35,
    tireDegradationRate: 'medium',
    altitude: 3,
    rainProbability: 0.03,
  },

  // ── Default fallback ─────────────────────────────────────────────────────────
  default: {
    type: 'balanced',
    overtakingDifficulty: 0.45,
    safetyCarProbability: 0.40,
    tireDegradationRate: 'medium',
    altitude: 50,
    rainProbability: 0.15,
  },
};
