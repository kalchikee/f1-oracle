#!/usr/bin/env python3
"""
F1 Oracle v4.1 — FastF1 Data Pipeline
Fetches real F1 timing data using the FastF1 library and outputs:
  - Constructor pace deltas per race (from qualifying and race lap times)
  - Driver circuit history
  - Upgrade trajectory tracking

Output: data/fastf1_pace_deltas.json (read by TypeScript pipeline)

Install: pip install fastf1 pandas numpy
"""

import sys
import json
import os
import logging
from pathlib import Path
from datetime import datetime

try:
    import fastf1
    import fastf1.plotting
    import pandas as pd
    import numpy as np
    HAS_FASTF1 = True
except ImportError:
    HAS_FASTF1 = False
    print("FastF1 not installed. Run: pip install fastf1 pandas numpy", file=sys.stderr)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('f1-oracle-pipeline')

# ── Paths ─────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / 'data'
CACHE_DIR = DATA_DIR / 'fastf1_cache'
OUTPUT_FILE = DATA_DIR / 'fastf1_pace_deltas.json'

DATA_DIR.mkdir(exist_ok=True)
CACHE_DIR.mkdir(exist_ok=True)


# ── Constructor ID normalization ───────────────────────────────────────────────

FASTF1_TO_ORACLE: dict[str, str] = {
    'Red Bull Racing': 'red_bull',
    'Ferrari': 'ferrari',
    'Mercedes': 'mercedes',
    'McLaren': 'mclaren',
    'Aston Martin': 'aston_martin',
    'Alpine': 'alpine',
    'Williams': 'williams',
    'Haas F1 Team': 'haas',
    'RB': 'rb',
    'Sauber': 'sauber',
    # Legacy names
    'AlphaTauri': 'rb',
    'Alpha Tauri': 'rb',
    'Kick Sauber': 'sauber',
    'Alfa Romeo': 'sauber',
}


def normalize_constructor(name: str) -> str:
    for k, v in FASTF1_TO_ORACLE.items():
        if k.lower() in name.lower():
            return v
    return name.lower().replace(' ', '_')


# ── Qualifying pace deltas ─────────────────────────────────────────────────────

def get_qualifying_pace_deltas(season: int, round_num: int) -> dict[str, float]:
    """
    Compute constructor pace deltas from qualifying session.
    Returns {constructor_id: gap_to_pole_in_seconds}
    """
    if not HAS_FASTF1:
        return {}

    try:
        session = fastf1.get_session(season, round_num, 'Q')
        session.load(laps=True, telemetry=False, weather=False, messages=False)

        laps = session.laps.pick_quicklaps()
        if laps.empty:
            log.warning(f"No quick laps for {season} Round {round_num} Q")
            return {}

        # Best lap per driver
        best_laps = laps.groupby('Driver')['LapTime'].min()

        # Map to constructor
        driver_constructor = {}
        for _, lap in laps.drop_duplicates('Driver').iterrows():
            driver = lap['Driver']
            team = getattr(lap, 'Team', None)
            if team:
                driver_constructor[driver] = normalize_constructor(str(team))

        # Best lap per constructor (best driver)
        constructor_best: dict[str, float] = {}
        for driver, lap_time in best_laps.items():
            constr = driver_constructor.get(str(driver))
            if constr is None:
                continue
            time_s = lap_time.total_seconds()
            if constr not in constructor_best or time_s < constructor_best[constr]:
                constructor_best[constr] = time_s

        if not constructor_best:
            return {}

        pole_time = min(constructor_best.values())
        deltas = {c: t - pole_time for c, t in constructor_best.items()}

        log.info(f"Q pace deltas {season} R{round_num}: {deltas}")
        return deltas

    except Exception as e:
        log.error(f"Failed qualifying pace for {season} R{round_num}: {e}")
        return {}


# ── Race pace deltas (fuel-adjusted median lap) ────────────────────────────────

def get_race_pace_deltas(season: int, round_num: int, exclude_laps: int = 5) -> dict[str, float]:
    """
    Compute constructor race pace deltas from race session.
    Uses median lap time per constructor, excluding first/last laps and pit laps.
    Returns {constructor_id: gap_to_fastest_in_seconds_per_lap}
    """
    if not HAS_FASTF1:
        return {}

    try:
        session = fastf1.get_session(season, round_num, 'R')
        session.load(laps=True, telemetry=False, weather=False, messages=False)

        laps = session.laps

        # Exclude pit in/out laps, first N laps, safety car laps
        clean_laps = laps[
            (~laps['PitOutTime'].notna()) &
            (~laps['PitInTime'].notna()) &
            (laps['LapNumber'] > exclude_laps) &
            (laps['TrackStatus'].isin(['1', '2', '4']))  # Green flag and VSC only
        ].copy()

        if clean_laps.empty:
            log.warning(f"No clean race laps for {season} R{round_num}")
            return {}

        # Map driver to constructor
        driver_constructor = {}
        for _, lap in laps.drop_duplicates('Driver').iterrows():
            driver = lap['Driver']
            team = getattr(lap, 'Team', None)
            if team:
                driver_constructor[str(driver)] = normalize_constructor(str(team))

        # Median lap time per constructor (best driver of the pair)
        constructor_pace: dict[str, list[float]] = {}
        for driver, group in clean_laps.groupby('Driver'):
            constr = driver_constructor.get(str(driver))
            if constr is None:
                continue
            times = group['LapTime'].dropna().apply(lambda t: t.total_seconds())
            if len(times) < 5:
                continue
            median_time = float(np.median(times))
            if constr not in constructor_pace:
                constructor_pace[constr] = []
            constructor_pace[constr].append(median_time)

        # Best driver per constructor
        constructor_median = {c: min(times) for c, times in constructor_pace.items() if times}

        if not constructor_median:
            return {}

        fastest = min(constructor_median.values())
        deltas = {c: t - fastest for c, t in constructor_median.items()}

        log.info(f"Race pace deltas {season} R{round_num}: {deltas}")
        return deltas

    except Exception as e:
        log.error(f"Failed race pace for {season} R{round_num}: {e}")
        return {}


# ── Upgrade trajectory ────────────────────────────────────────────────────────

def compute_upgrade_trajectory(pace_history: list[float]) -> float:
    """
    Linear regression on pace delta history.
    Negative slope = improving (car getting faster vs field).
    Returns slope in seconds/lap per race.
    """
    if len(pace_history) < 3:
        return 0.0
    x = np.arange(len(pace_history))
    slope = float(np.polyfit(x, pace_history, 1)[0])
    return slope


# ── Main run ──────────────────────────────────────────────────────────────────

def run(season: int, last_n_races: int = 5) -> None:
    if not HAS_FASTF1:
        log.error("FastF1 not available. Outputting empty data.")
        output = {'season': season, 'round': 0, 'qualifying_deltas': {}, 'race_deltas': {}, 'upgrade_trajectory': {}}
        OUTPUT_FILE.write_text(json.dumps(output, indent=2))
        return

    if HAS_FASTF1:
        fastf1.Cache.enable_cache(str(CACHE_DIR))

    # Get schedule
    try:
        schedule = fastf1.get_event_schedule(season, include_testing=False)
        # Use naive UTC timestamp to compare against naive EventDate from fastf1
        # (EventDate is tz-naive, so we need a tz-naive "now" to compare)
        now_utc_naive = pd.Timestamp.utcnow().tz_localize(None)
        completed = schedule[schedule['EventDate'] < now_utc_naive]
        last_rounds = completed['RoundNumber'].dropna().astype(int).tolist()[-last_n_races:]
    except Exception as e:
        log.error(f"Failed to get schedule: {e}")
        last_rounds = []

    if not last_rounds:
        log.warning("No completed rounds found")
        output = {'season': season, 'round': 0, 'qualifying_deltas': {}, 'race_deltas': {}, 'upgrade_trajectory': {}}
        OUTPUT_FILE.write_text(json.dumps(output, indent=2))
        return

    latest_round = last_rounds[-1]
    log.info(f"Processing Season {season}, rounds: {last_rounds}")

    # Collect pace history per constructor
    q_history: dict[str, list[float]] = {}
    r_history: dict[str, list[float]] = {}

    for rnd in last_rounds:
        q_deltas = get_qualifying_pace_deltas(season, rnd)
        r_deltas = get_race_pace_deltas(season, rnd)

        for constr, delta in q_deltas.items():
            q_history.setdefault(constr, []).append(delta)
        for constr, delta in r_deltas.items():
            r_history.setdefault(constr, []).append(delta)

    # Latest deltas
    latest_q = get_qualifying_pace_deltas(season, latest_round)
    latest_r = get_race_pace_deltas(season, latest_round)

    # Rolling average for current round
    q_avg = {}
    for constr, history in q_history.items():
        q_avg[constr] = float(np.mean(history[-3:]))  # 3-race rolling avg

    r_avg = {}
    for constr, history in r_history.items():
        r_avg[constr] = float(np.mean(history[-5:]))  # 5-race rolling avg

    # Upgrade trajectories
    trajectories = {}
    for constr in set(list(q_history.keys()) + list(r_history.keys())):
        history = q_history.get(constr, [])
        trajectories[constr] = compute_upgrade_trajectory(history)

    output = {
        'season': season,
        'round': latest_round,
        'generated_at': datetime.utcnow().isoformat() + 'Z',
        'qualifying_deltas': q_avg,
        'race_deltas': r_avg,
        'latest_qualifying_deltas': latest_q,
        'latest_race_deltas': latest_r,
        'upgrade_trajectory': trajectories,
        'rounds_used': last_rounds,
    }

    OUTPUT_FILE.write_text(json.dumps(output, indent=2))
    log.info(f"FastF1 data written to {OUTPUT_FILE}")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='F1 Oracle FastF1 Data Pipeline')
    parser.add_argument('--season', type=int, default=datetime.now().year)
    parser.add_argument('--last-n', type=int, default=5, help='Number of recent races to use')
    args = parser.parse_args()

    run(args.season, args.last_n)
