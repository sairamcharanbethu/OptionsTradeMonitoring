"""Bit-for-bit parity between the ``se_kernel`` Rust extension and the Python
reference bodies in ``signal_engine`` (the ``*_py`` functions).

Skips when the extension is not installed. Uses seeded random bar series with
the quirks real feeds produce (int and float volumes, zero / None / missing
volume, missing or malformed ``time``) across sessions that straddle both 2026
DST transitions, and asserts equality of value *and* type.
"""
from __future__ import annotations

import random
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

import signal_engine as se

try:
    import se_kernel
except ImportError:  # pragma: no cover
    se_kernel = None

ET = ZoneInfo("America/New_York")


def _et(date: str, hour: int, minute: int) -> float:
    return datetime.strptime(date, "%Y-%m-%d").replace(hour=hour, minute=minute, tzinfo=ET).timestamp()


def _series(rng: random.Random, dates: list[str], *, quirks: bool) -> list[dict]:
    bars = []
    price = 500.0
    for date in dates:
        start = _et(date, 9, 30)
        for i in range(390):
            stamp = start + 60 * i
            move = rng.gauss(0, 0.3)
            open_ = price
            close = price + move
            high = max(open_, close) + abs(rng.gauss(0, 0.1))
            low = min(open_, close) - abs(rng.gauss(0, 0.1))
            price = close
            volume: object = rng.choice([rng.randint(0, 50000), float(rng.randint(0, 50000))])
            bar = {"time": float(stamp) if rng.random() < 0.7 else int(stamp),
                   "open": open_, "high": high, "low": low, "close": close, "volume": volume}
            if quirks:
                roll = rng.random()
                if roll < 0.02:
                    bar["volume"] = None
                elif roll < 0.04:
                    del bar["volume"]
                elif roll < 0.06:
                    bar["volume"] = 0
                elif roll < 0.07:
                    bar["volume"] = 0.0
            bars.append(bar)
    return bars


def _types(value):
    if isinstance(value, dict):
        return {k: _types(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_types(v) for v in value]
    return type(value).__name__


@unittest.skipIf(se_kernel is None, "se_kernel extension not installed")
class KernelParity(unittest.TestCase):
    # Sessions around both DST changes plus an ordinary week.
    DATES = [
        ["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09", "2026-03-10"],
        ["2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03"],
        ["2026-08-13", "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"],
    ]

    def _cases(self):
        rng = random.Random(20260913)
        for dates in self.DATES:
            for quirks in (False, True):
                bars = _series(rng, dates, quirks=quirks)
                last = dates[-1]
                for hour, minute in ((9, 31), (9, 45), (11, 0), (13, 7), (15, 59), (16, 0), (17, 30)):
                    now = _et(last, hour, minute) + rng.choice([0.0, 5.0, 59.999, 0.4999995])
                    yield bars, now

    def assertSame(self, expected, actual, msg=""):
        self.assertEqual(expected, actual, msg)
        self.assertEqual(_types(expected), _types(actual), f"type mismatch {msg}")

    def test_session_and_completed_bars_return_original_objects(self):
        for bars, now in self._cases():
            with patch("signal_engine.time.time", return_value=now):
                expected = se._session_bars_py(bars)
                completed = se._completed_bars_py(bars)
            actual = se_kernel.session_bars(bars, now)
            self.assertEqual([id(b) for b in expected], [id(b) for b in actual])
            self.assertEqual([id(b) for b in completed], [id(b) for b in se_kernel.completed_bars(bars, now)])
            self.assertEqual([id(b) for b in se._session_bars_py(bars, now=now)], [id(b) for b in actual])

    def test_aggregate_bars(self):
        for bars, now in self._cases():
            with patch("signal_engine.time.time", return_value=now):
                completed = se._completed_bars_py(bars)
                for minutes in (3, 5, 15, 60):
                    expected = se._aggregate_bars_py(completed, minutes)
                    self.assertSame(expected, se_kernel.aggregate_bars(completed, minutes, now), f"agg {minutes}")

    def test_scalar_helpers(self):
        for bars, now in self._cases():
            with patch("signal_engine.time.time", return_value=now):
                completed = se._completed_bars_py(se._session_bars_py(bars))
                all_completed = se._completed_bars_py(bars)
            latest = completed[-1] if completed else None
            self.assertSame(se._time_of_day_rvol_py(latest, all_completed),
                            se_kernel.time_of_day_rvol(latest, all_completed))
            self.assertSame(se._time_of_day_rvol_py(None, all_completed), se_kernel.time_of_day_rvol(None, all_completed))
            atr = se_kernel.atr(completed)
            self.assertSame(se._atr_py(completed), None if atr is None else round(atr, 4))
            closes = [float(b["close"]) for b in completed]
            for period in (9, 21):
                ema = se_kernel.ema(closes, period)
                self.assertSame(se._ema_py(closes, period), None if ema is None else round(ema, 4))
            clean = [b for b in completed if b.get("volume") is not None]
            self.assertSame(se._median_volume_py(clean), se_kernel.median_volume(clean))
            vwap = se_kernel.completed_vwap(clean, now)
            self.assertSame(se._completed_vwap_py(clean, now), None if vwap is None else round(vwap, 4))

    def test_calculate_indicators_end_to_end(self):
        for bars, now in self._cases():
            # the reference raises on a None volume in the latest bar exactly like live code would;
            # keep the comparison on inputs both sides accept
            clean = [b for b in bars if b.get("volume") is not None]
            with patch("signal_engine.time.time", return_value=now):
                expected = se._calculate_indicators_py(clean)
            actual = se._assemble_indicators(se_kernel.indicator_core(clean, now))
            self.assertEqual(list(expected), list(actual), "key order")
            self.assertSame(expected, actual)

    def test_error_parity(self):
        now = _et("2026-08-20", 10, 0)
        with self.assertRaises(TypeError):
            se._completed_bars_py([{"time": None}])
        with self.assertRaises(TypeError):
            se_kernel.completed_bars([{"time": None}], now)
        with self.assertRaises(KeyError):
            se._aggregate_bars_py([{"open": 1.0}], 5)
        with self.assertRaises(KeyError):
            se_kernel.aggregate_bars([{"open": 1.0}], 5, now)
        with self.assertRaises(TypeError):
            se._median_volume_py([{"volume": None}])
        with self.assertRaises(TypeError):
            se_kernel.median_volume([{"volume": None}])
        # malformed time is skipped, not raised, by session filtering
        bad = [{"time": None}, {"time": "nope"}, {}, {"time": now - 60, "close": 1.0}]
        self.assertEqual(se._session_bars_py(bad, now=now), se_kernel.session_bars(bad, now))

    def test_dispatch_matches_mode(self):
        self.assertIn(se.kernel_backend(), {"rust", "python"})
        self.assertEqual(se.kernel_backend() == "rust", se._USE_RUST)


if __name__ == "__main__":
    unittest.main()
