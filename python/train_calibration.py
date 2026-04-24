#!/usr/bin/env python3
"""
F1 Oracle v4.1 — Platt Scaling Calibration
Trains logistic regression calibration on historical simulation outputs vs actual results.

Input:  data/f1_oracle.db  (race_predictions table)
Output: data/calibration_params.json

Platt scaling: P_calibrated = sigmoid(a * logit(P_raw) + b)
where a, b are fitted by logistic regression on historical data.

Install: pip install scikit-learn pandas numpy
"""

import sys
import json
import sqlite3
import logging
from pathlib import Path
from datetime import datetime

try:
    import numpy as np
    import pandas as pd
    from sklearn.linear_model import LogisticRegression
    from sklearn.calibration import CalibratedClassifierCV, calibration_curve
    from sklearn.model_selection import cross_val_score
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False
    print("scikit-learn not installed. Run: pip install scikit-learn pandas numpy", file=sys.stderr)

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('f1-calibration')

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / 'data'
DB_PATH = DATA_DIR / 'f1_oracle.db'
OUTPUT_FILE = DATA_DIR / 'calibration_params.json'


def logit(p: float) -> float:
    p = max(0.001, min(0.999, p))
    return float(np.log(p / (1 - p)))


def load_historical_predictions(db_path: Path) -> pd.DataFrame:
    """Load completed race predictions with actuals from SQLite."""
    if not db_path.exists():
        log.warning(f"DB not found at {db_path}")
        return pd.DataFrame()

    conn = sqlite3.connect(str(db_path))
    try:
        df = pd.read_sql_query(
            """
            SELECT
                winner_probability,
                podium_prob_1,
                podium_prob_2,
                podium_prob_3,
                winner_correct,
                podium_correct,
                top5_correct,
                season,
                round
            FROM race_predictions
            WHERE winner_correct IS NOT NULL
              AND simulation_mode IN ('post_qualifying', 'practice_only')
            ORDER BY season, round
            """,
            conn,
        )
    except Exception as e:
        log.error(f"DB query failed: {e}")
        df = pd.DataFrame()
    finally:
        conn.close()

    return df


def fit_platt_scaling(raw_probs: np.ndarray, actuals: np.ndarray) -> tuple[float, float]:
    """
    Fit Platt scaling: logistic regression on logit(raw_prob) → actual outcome.
    Returns (a, b) coefficients.
    """
    if not HAS_SKLEARN or len(raw_probs) < 10:
        log.warning("Insufficient data or sklearn unavailable. Using identity calibration.")
        return 1.0, 0.0

    X = np.array([[logit(p)] for p in raw_probs])
    y = actuals.astype(int)

    lr = LogisticRegression(C=1.0, solver='lbfgs', max_iter=1000)
    lr.fit(X, y)

    a = float(lr.coef_[0][0])
    b = float(lr.intercept_[0])

    # Cross-validation score
    scores = cross_val_score(lr, X, y, cv=min(5, len(y) // 2), scoring='neg_log_loss')
    log.info(f"Platt scaling CV log-loss: {-scores.mean():.4f} ± {scores.std():.4f}")

    return a, b


def run() -> None:
    df = load_historical_predictions(DB_PATH)

    output = {
        'generated_at': datetime.utcnow().isoformat() + 'Z',
        'n_races': 0,
        'win_calibration': {'a': 1.0, 'b': 0.0},
        'podium_calibration': {'a': 1.0, 'b': 0.0},
        'notes': '',
    }

    if df.empty:
        log.warning("No historical data available. Using identity calibration (a=1, b=0).")
        output['notes'] = 'No historical data — identity calibration applied'
        OUTPUT_FILE.write_text(json.dumps(output, indent=2))
        return

    n = len(df)
    log.info(f"Training calibration on {n} races")

    # Winner calibration
    win_probs = df['winner_probability'].values
    win_actual = df['winner_correct'].values

    if len(win_probs) >= 10:
        a_win, b_win = fit_platt_scaling(win_probs, win_actual)
        log.info(f"Winner calibration: a={a_win:.4f}, b={b_win:.4f}")
    else:
        a_win, b_win = 1.0, 0.0
        log.warning("Insufficient data for winner calibration")

    # Podium calibration (pool P1+P2+P3 predictions)
    pod_probs = np.concatenate([
        df['podium_prob_1'].values,
        df['podium_prob_2'].values,
        df['podium_prob_3'].values,
    ])
    pod_correct = np.where(df['podium_correct'].isna(), 0, df['podium_correct'].values).astype(float)
    pod_actual = np.concatenate([
        (df['winner_correct'].fillna(0).values == 1).astype(float),
        (pod_correct >= 2).astype(float),
        (pod_correct >= 3).astype(float),
    ])

    # Remove NaN
    valid = ~(np.isnan(pod_probs) | np.isnan(pod_actual))
    pod_probs = pod_probs[valid]
    pod_actual = pod_actual[valid]

    if len(pod_probs) >= 10:
        a_pod, b_pod = fit_platt_scaling(pod_probs, pod_actual)
        log.info(f"Podium calibration: a={a_pod:.4f}, b={b_pod:.4f}")
    else:
        a_pod, b_pod = 1.0, 0.0

    # Accuracy metrics
    win_accuracy = float(win_actual.mean()) if len(win_actual) > 0 else 0.0
    log.info(f"Historical winner accuracy: {win_accuracy:.1%} over {n} races")

    output.update({
        'n_races': n,
        'win_calibration': {'a': float(a_win), 'b': float(b_win)},
        'podium_calibration': {'a': float(a_pod), 'b': float(b_pod)},
        'win_accuracy': win_accuracy,
        'notes': f'Trained on {n} races from {df["season"].min()}–{df["season"].max()}',
    })

    OUTPUT_FILE.write_text(json.dumps(output, indent=2))
    log.info(f"Calibration params written to {OUTPUT_FILE}")


if __name__ == '__main__':
    run()
