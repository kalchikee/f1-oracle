// F1 Oracle v4.1 — Discord Webhook Alerts
// Three embed types:
//   1. Post-Practice (Friday) — initial predictions from FP pace
//   2. Post-Qualifying (Saturday) — strongest predictions with grid positions
//   3. Post-Race Recap (Sunday) — actual results vs predicted, accuracy update

import fetch from 'node-fetch';
import { logger } from '../logger.js';
import type { DriverSimResult, RaceSimulation, SeasonAccuracy, RaceContext } from '../types.js';

// ─── F1 Oracle brand color ────────────────────────────────────────────────────

const F1_RED = 0xE10600;       // F1 official red
const GOLD = 0xFFD700;         // correct prediction
const DARK_RED = 0x8B0000;     // wrong prediction

// ─── Discord types ────────────────────────────────────────────────────────────

interface DiscordField { name: string; value: string; inline?: boolean; }
interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordField[];
  footer?: { text: string };
  timestamp?: string;
}
interface DiscordPayload { content?: string; embeds: DiscordEmbed[]; }

// ─── Webhook sender ───────────────────────────────────────────────────────────

async function sendWebhook(payload: DiscordPayload): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.warn('DISCORD_WEBHOOK_URL not set — skipping Discord alert');
    return false;
  }
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      logger.error({ status: resp.status, body: text }, 'Discord webhook error');
      return false;
    }
    logger.info('Discord embed sent');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to send Discord webhook');
    return false;
  }
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function pct(prob: number): string {
  return (Math.round(prob * 1000) / 10).toFixed(1) + '%';
}

function medalEmoji(position: number): string {
  if (position === 1) return '🥇';
  if (position === 2) return '🥈';
  if (position === 3) return '🥉';
  return `P${position}`;
}

function confidenceBars(prob: number): string {
  if (prob >= 0.50) return '🔥🔥🔥';
  if (prob >= 0.35) return '🔥🔥';
  if (prob >= 0.20) return '🔥';
  if (prob >= 0.10) return '✅';
  return '•';
}

function circuitTypeLabel(type: RaceContext['circuitType']): string {
  const labels: Record<RaceContext['circuitType'], string> = {
    street: '🏙️ Street Circuit',
    high_speed: '💨 High-Speed',
    high_downforce: '🌀 High-Downforce',
    power: '⚡ Power Circuit',
    balanced: '⚖️ Balanced',
  };
  return labels[type];
}

function weatherLabel(weather: RaceContext['weather'], rainProb: number): string {
  if (weather === 'wet') return `🌧️ Wet (${pct(rainProb)} rain)`;
  if (weather === 'mixed') return `🌦️ Mixed (${pct(rainProb)} rain)`;
  return `☀️ Dry (${pct(rainProb)} rain)`;
}

// ─── 1. Post-Practice Embed (Friday) ─────────────────────────────────────────

export async function sendPostPracticeEmbed(
  sim: RaceSimulation,
  context: RaceContext,
  seasonAcc: SeasonAccuracy | null,
): Promise<boolean> {
  const top5 = sim.results.slice(0, 5);
  const top10 = sim.results.slice(0, 10);

  // Top 5 predictions
  const top5Field = top5
    .map((d, i) => `${medalEmoji(i + 1)} **${d.driverName}** (${d.constructorName})  —  Win: ${pct(d.calibratedWinProb)} | Pod: ${pct(d.podiumProbability)}`)
    .join('\n');

  // Accuracy record
  let recordField = 'No races scored yet this season.';
  if (seasonAcc && seasonAcc.totalRaces > 0) {
    recordField = [
      `🏆 Winner: **${seasonAcc.winnerCorrect}/${seasonAcc.totalRaces}** (${pct(seasonAcc.winnerAccuracy)})`,
      `🥇 Podium: **${pct(seasonAcc.podiumSlotAccuracy)}** slot accuracy`,
      `🤝 H2H: **${seasonAcc.h2hCorrect}/${seasonAcc.h2hTotal}** (${pct(seasonAcc.h2hAccuracy)})`,
    ].join('\n');
  }

  const embed: DiscordEmbed = {
    title: `🏁 F1 Oracle — ${context.grandPrix} | Friday Preview`,
    description: `${context.circuit} | Round ${context.round} of ${context.totalRounds} | ${circuitTypeLabel(context.circuitType)} | ${weatherLabel(context.weather, context.rainProbability)}`,
    color: F1_RED,
    fields: [
      {
        name: '📊 Season Record',
        value: recordField,
        inline: false,
      },
      {
        name: '🏎️ Practice-Based Top 5 Predictions',
        value: top5Field || 'No data.',
        inline: false,
      },
      {
        name: '⚠️ Key Factors',
        value: [
          `Safety Car Probability: **${pct(context.safetyCarProbability)}**`,
          `Circuit: ${circuitTypeLabel(context.circuitType)}`,
          `Overtaking Difficulty: **${context.overtakingDifficulty < 0.3 ? 'Easy' : context.overtakingDifficulty < 0.6 ? 'Medium' : 'Hard'}**`,
          context.isSprintWeekend ? '⚡ Sprint Weekend' : '',
        ].filter(Boolean).join('\n'),
        inline: false,
      },
    ],
    footer: { text: `F1 Oracle v4.1 | Post-Practice | Full predictions after qualifying Saturday` },
    timestamp: new Date().toISOString(),
  };

  return sendWebhook({ embeds: [embed] });
}

// ─── 2. Post-Qualifying Embed (Saturday) ─────────────────────────────────────

export async function sendPostQualifyingEmbed(
  sim: RaceSimulation,
  context: RaceContext,
  driverFeatures: Array<{ driverId: string; qualiPosition: number | null; teammateDelta: number }>,
  seasonAcc: SeasonAccuracy | null,
): Promise<boolean> {
  const top10 = sim.results.slice(0, 10);
  const top3 = sim.results.slice(0, 3);

  // Find pole sitter
  const poleSitter = driverFeatures
    .filter(d => d.qualiPosition !== null)
    .sort((a, b) => (a.qualiPosition ?? 99) - (b.qualiPosition ?? 99))[0];
  const poleDriver = sim.results.find(r => r.driverId === poleSitter?.driverId);

  // Predicted Top 10
  const top10Lines = top10.map((d, i) => {
    const pos = i + 1;
    const emoji = pos <= 3 ? medalEmoji(pos) : `P${pos}`;
    const bar = pos === 1 ? confidenceBars(d.calibratedWinProb) : '';
    const probStr = pos === 1
      ? `${pct(d.calibratedWinProb)} win`
      : pos <= 3
        ? `${pct(d.podiumProbability)} pod`
        : `${pct(d.top10Probability)} pts`;
    return `${emoji} ${bar} **${d.driverName}** (${d.constructorName})  ·  ${probStr}`;
  }).join('\n');

  // Teammate matchups (5 pairs)
  const constructorIds = [...new Set(sim.results.map(r => r.constructorId))];
  const h2hLines: string[] = [];
  for (const constrId of constructorIds.slice(0, 5)) {
    const pair = sim.results.filter(r => r.constructorId === constrId);
    if (pair.length < 2) continue;
    const [a, b] = pair;
    const aH2H = a.teammateH2HProbability;
    h2hLines.push(`**${a.driverName}** ${pct(aH2H)} vs ${pct(1 - aH2H)} **${b.driverName}**`);
  }

  // Season record
  let recordValue = 'No races scored yet.';
  if (seasonAcc && seasonAcc.totalRaces > 0) {
    recordValue = `${seasonAcc.winnerCorrect}/${seasonAcc.totalRaces} (${pct(seasonAcc.winnerAccuracy)})`;
  }
  let podiumValue = 'N/A';
  if (seasonAcc && seasonAcc.podiumSlotsTotal > 0) {
    podiumValue = `${seasonAcc.podiumSlotsCorrect}/${seasonAcc.podiumSlotsTotal} (${pct(seasonAcc.podiumSlotAccuracy)})`;
  }

  const embeds: DiscordEmbed[] = [
    {
      title: `🏁 F1 Oracle — ${context.grandPrix} | Post-Qualifying Predictions`,
      description: `${context.circuit} | Round ${context.round} of ${context.totalRounds} | ${weatherLabel(context.weather, context.rainProbability)}`,
      color: F1_RED,
      fields: [
        { name: '🏆 Season Record (Winner)', value: recordValue, inline: true },
        { name: '🥇 Podium Accuracy', value: podiumValue, inline: true },
        { name: '🏎️ SC Probability', value: `${pct(context.safetyCarProbability)}`, inline: true },
        {
          name: '📋 Predicted Top 10',
          value: top10Lines,
          inline: false,
        },
        {
          name: '🤝 Teammate Matchups',
          value: h2hLines.join('\n') || 'N/A',
          inline: false,
        },
        {
          name: '⚡ Key Details',
          value: [
            `Fastest Lap Favourite: **${sim.results[0]?.driverName}** (${pct(sim.results[0]?.fastestLapProbability ?? 0)})`,
            `Highest DNF Risk: **${[...sim.results].sort((a, b) => b.dnfProbability - a.dnfProbability)[0]?.driverName}** (${pct([...sim.results].sort((a, b) => b.dnfProbability - a.dnfProbability)[0]?.dnfProbability ?? 0)})`,
            context.isSprintWeekend ? '⚡ Sprint Weekend — sprint result used as input' : '',
          ].filter(Boolean).join('\n'),
          inline: false,
        },
      ],
      footer: {
        text: `F1 Oracle v4.1 | Post-Qualifying | Pole: ${poleDriver?.driverName ?? 'TBD'} | ${sim.simulations.toLocaleString()} simulations`,
      },
      timestamp: new Date().toISOString(),
    },
  ];

  return sendWebhook({ embeds });
}

// ─── 3. Post-Race Recap Embed (Sunday) ───────────────────────────────────────

export interface RaceActuals {
  winner: string;
  p2: string;
  p3: string;
  topFive: string[];
  topTen: string[];
  fastestLap: string;
}

export async function sendPostRaceRecap(
  sim: RaceSimulation,
  actuals: RaceActuals,
  context: RaceContext,
  seasonAcc: SeasonAccuracy,
  // Championship standings (top 5 drivers)
  driverStandings?: Array<{ driverName: string; points: number; position: number }>,
  constructorStandings?: Array<{ constructorName: string; points: number; position: number }>,
): Promise<boolean> {
  const predicted = sim.results;
  const predictedWinner = predicted[0];
  const predictedP2 = predicted[1];
  const predictedP3 = predicted[2];

  const winnerCorrect = predictedWinner?.driverId === actuals.winner ||
    predictedWinner?.driverName === actuals.winner;
  const recapColor = winnerCorrect ? GOLD : DARK_RED;

  // Build per-position comparison (top 10)
  const positionLines: string[] = [];
  for (let i = 0; i < Math.min(10, predicted.length); i++) {
    const pred = predicted[i];
    const actualDriverAtPos = i < actuals.topTen.length ? actuals.topTen[i] : '?';
    const match = pred.driverName === actualDriverAtPos || pred.driverId === actualDriverAtPos;
    const withinTwo = !match && i < 10; // simplified check
    const emoji = match ? '✅' : '❌';
    positionLines.push(`${emoji} P${i + 1}: Pred **${pred.driverName}** → Actual **${actualDriverAtPos}**`);
  }

  // Podium accuracy
  const podiumPredicted = [predictedWinner, predictedP2, predictedP3].map(d => d?.driverName ?? '?');
  const podiumActual = [actuals.winner, actuals.p2, actuals.p3];
  const podiumCorrectCount = podiumPredicted.filter((p, i) => p === podiumActual[i]).length;

  // Season record display
  const seasonRecord = [
    `🏆 **Winner: ${seasonAcc.winnerCorrect}/${seasonAcc.totalRaces}** (${pct(seasonAcc.winnerAccuracy)})`,
    `🥇 **Podium: ${seasonAcc.podiumSlotsCorrect}/${seasonAcc.podiumSlotsTotal}** (${pct(seasonAcc.podiumSlotAccuracy)})`,
    `🎯 **Top-5: ${pct(seasonAcc.top5SetAccuracy)}**`,
    `🤝 **H2H: ${seasonAcc.h2hCorrect}/${seasonAcc.h2hTotal}** (${pct(seasonAcc.h2hAccuracy)})`,
  ].join('\n');

  // Championship standings
  let championshipField = '';
  if (driverStandings && driverStandings.length > 0) {
    championshipField = driverStandings.slice(0, 5)
      .map(d => `${d.position}. **${d.driverName}** — ${d.points} pts`)
      .join('\n');
  }

  const embeds: DiscordEmbed[] = [
    {
      title: `🏁 F1 Oracle — ${context.grandPrix} Recap ${winnerCorrect ? '✅' : '❌'}`,
      description: `${context.circuit} | Round ${context.round} of ${context.totalRounds}`,
      color: recapColor,
      fields: [
        {
          name: winnerCorrect ? '🏆 Winner: CORRECT ✅' : '🏆 Winner: MISSED ❌',
          value: `Predicted: **${predictedWinner?.driverName}** (${pct(predictedWinner?.calibratedWinProb ?? 0)})\nActual: **${actuals.winner}**`,
          inline: true,
        },
        {
          name: '🥇 Podium Accuracy',
          value: `**${podiumCorrectCount}/3** correct`,
          inline: true,
        },
        {
          name: '📊 Season Running Record',
          value: seasonRecord,
          inline: false,
        },
        {
          name: '📋 Position-by-Position (Top 10)',
          value: positionLines.join('\n') || 'N/A',
          inline: false,
        },
        ...(championshipField ? [{
          name: '🏆 Championship Standings',
          value: championshipField,
          inline: false,
        }] : []),
      ],
      footer: {
        text: `Round ${context.round} of ${context.totalRounds} | Season winner accuracy: ${pct(seasonAcc.winnerAccuracy)} | F1 Oracle v4.1`,
      },
      timestamp: new Date().toISOString(),
    },
  ];

  return sendWebhook({ embeds });
}

// ─── Preseason Setup Embed ────────────────────────────────────────────────────

export async function sendPreseasonEmbed(
  season: number,
  constructorModel: Array<{ constructorName: string; finalDelta: number; dataSource: string }>,
  totalRounds: number,
): Promise<boolean> {
  const constructorLines = constructorModel
    .slice(0, 10)
    .map((c, i) => `${i + 1}. **${c.constructorName}** — baseline delta: +${c.finalDelta.toFixed(3)}s/lap (${c.dataSource})`)
    .join('\n');

  return sendWebhook({
    embeds: [{
      title: `🏁 F1 Oracle — ${season} Season Initialized`,
      description: `${totalRounds}-race season. Constructor Power Model loaded. Driver Elo seeded. Ready for Round 1.`,
      color: F1_RED,
      fields: [
        {
          name: '🏎️ Constructor Power Baseline',
          value: constructorLines || 'No data.',
          inline: false,
        },
        {
          name: '📅 Season Info',
          value: [
            `Rounds: **${totalRounds}**`,
            season === 2026 ? '⚠️ **Regulation Change Year** — prior-season data heavily discounted' : '',
            `Model Version: **F1 Oracle v4.1**`,
            `Simulation: **10,000 iterations per race**`,
          ].filter(Boolean).join('\n'),
          inline: false,
        },
      ],
      footer: { text: `F1 Oracle v4.1 | ${season} Preseason Setup | github.com/actions` },
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Season-end summary ───────────────────────────────────────────────────────

export async function sendSeasonEndEmbed(season: number, acc: SeasonAccuracy): Promise<boolean> {
  return sendWebhook({
    embeds: [{
      title: `🏆 F1 Oracle — ${season} Season Complete`,
      description: `Final accuracy report after ${acc.totalRaces} races.`,
      color: GOLD,
      fields: [
        {
          name: '🏁 Final Accuracy',
          value: [
            `🏆 Winner: **${acc.winnerCorrect}/${acc.totalRaces}** (${pct(acc.winnerAccuracy)}) — target ≥ 45%`,
            `🥇 Podium (per slot): **${pct(acc.podiumSlotAccuracy)}** — target ≥ 75%`,
            `🎯 Top-5 Set: **${pct(acc.top5SetAccuracy)}** — target ≥ 85%`,
            `🤝 Teammate H2H: **${acc.h2hCorrect}/${acc.h2hTotal}** (${pct(acc.h2hAccuracy)}) — target ≥ 70%`,
          ].join('\n'),
          inline: false,
        },
      ],
      footer: { text: `F1 Oracle v4.1 | Season ${season} Complete | See you in ${season + 1}` },
      timestamp: new Date().toISOString(),
    }],
  });
}
