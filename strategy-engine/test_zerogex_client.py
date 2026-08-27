#!/usr/bin/env python3

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from zerogex_client import (
    ADVANCED_ENDPOINTS,
    ZeroGEXAuthError,
    ZeroGEXError,
    fetch_component_snapshot,
    fetch_snapshot,
    get_api_key,
    normalize_snapshot,
    render_text,
)


class ZeroGEXClientTest(unittest.TestCase):
    def test_normalization_keeps_compact_research_fields(self) -> None:
        snapshot = normalize_snapshot(
            "spy",
            {
                "bias_score": -60.95,
                "direction": "short",
                "bias": {"code": "RANGE_FADE", "label": "Range Fade"},
                "market_state": "CHOP",
                "conviction_driven": False,
                "timestamp": "2026-07-27T14:20:00+00:00",
                "secret_internal_field": "discard",
            },
            {
                "symbol": "SPY",
                "gamma_flip": 747.66,
                "call_wall": 745.0,
                "put_wall": 740.0,
                "unknown": "discard",
            },
            {
                "signals": {
                    "tape_flow_bias": {
                        "score": -52.0,
                        "direction": "bearish",
                        "timestamp": "2026-07-27T14:20:00+00:00",
                        "context_values": {"momentum_5bar": -0.001},
                        "unknown": "discard",
                    },
                    "positioning_trap": None,
                }
            },
            fetched_at=1_000.0,
        )

        self.assertEqual(snapshot["source"], "zerogex")
        self.assertEqual(snapshot["mode"], "shadow")
        self.assertEqual(snapshot["symbol"], "SPY")
        self.assertNotIn("secret_internal_field", snapshot["trade_bias"])
        self.assertNotIn("unknown", snapshot["gex_summary"])
        self.assertNotIn(
            "unknown", snapshot["basic_signals"]["tape_flow_bias"]
        )
        self.assertEqual(
            snapshot["trade_bias"]["bias"]["code"],
            "RANGE_FADE",
        )
        self.assertEqual(snapshot["trade_bias"]["market_state"], "CHOP")
        self.assertFalse(snapshot["trade_bias"]["conviction_driven"])
        self.assertEqual(
            snapshot["basic_signals"]["tape_flow_bias"]["context_values"][
                "momentum_5bar"
            ],
            -0.001,
        )
        self.assertIsNone(snapshot["basic_signals"]["positioning_trap"])

    def test_advanced_normalization_promotes_nested_diagnostics(self) -> None:
        snapshot = normalize_snapshot(
            "SPY",
            {},
            {"symbol": "SPY"},
            {"signals": {}},
            advanced_signals={
                "squeeze_setup": {
                    "timestamp": "2026-07-27T17:02:00+00:00",
                    "score": -78.54,
                    "direction": "bearish",
                    "context_values": {
                        "triggered": True,
                        "signal": "bearish_squeeze",
                        "accel_dn": False,
                        "accel_up": False,
                        "momentum_5bar": -0.0004,
                        "large_unused_blob": "discard",
                    },
                    "score_history": [{"score": -78.54}],
                },
                "zero_dte_position_imbalance": {
                    "timestamp": "2026-07-27T17:02:00+00:00",
                    "score": -75.0,
                    "direction": "bearish",
                    "context_values": {
                        "triggered": True,
                        "flow_source": "zero_dte",
                        "tod_multiplier": 0.9,
                    },
                },
                "range_break_imminence": {
                    "timestamp": "2026-07-27T17:02:00+00:00",
                    "score": -66.0,
                    "direction": "bearish",
                    "context_values": {
                        "triggered": True,
                        "label": "Break Watch",
                        "imminence": 70.73,
                        "trap": {
                            "range_low": 736.2,
                            "range_high": 737.4,
                            "near_low_pct": 0.01,
                        },
                    },
                },
            },
        )

        squeeze = snapshot["advanced_signals"]["squeeze_setup"]
        self.assertTrue(squeeze["triggered"])
        self.assertFalse(squeeze["accel_dn"])
        self.assertNotIn("score_history", squeeze)
        self.assertNotIn(
            "large_unused_blob",
            squeeze["context_values"],
        )
        zero_dte = snapshot["advanced_signals"][
            "zero_dte_position_imbalance"
        ]
        self.assertEqual(zero_dte["flow_source"], "zero_dte")
        range_break = snapshot["advanced_signals"][
            "range_break_imminence"
        ]
        self.assertEqual(range_break["label"], "Break Watch")
        self.assertEqual(
            range_break["context_values"]["trap"]["range_low"],
            736.2,
        )

    def test_normalization_sanitizes_playbook_order_fields(self) -> None:
        snapshot = normalize_snapshot(
            "SPY",
            {},
            {"symbol": "SPY"},
            {"signals": {}},
            playbook={
                "timestamp": "2026-07-27T15:00:00+00:00",
                "action": "BUY_PUT_DEBIT",
                "pattern": "opening_range_break",
                "direction": "bearish",
                "confidence": 0.72,
                "rationale": "Price structure confirmed.",
                "legs": [{"right": "P", "strike": 738}],
                "entry": {"ref_price": 738},
                "near_misses": [],
            },
        )

        playbook = snapshot["playbook"]
        self.assertEqual(playbook["state"], "candidate")
        self.assertEqual(playbook["direction"], "bearish")
        self.assertNotIn("action", playbook)
        self.assertNotIn("legs", playbook)
        self.assertNotIn("entry", playbook)

    def test_fetch_uses_documented_core_read_endpoints(self) -> None:
        calls = []

        def request_json(path, params, **kwargs):
            calls.append((path, params, kwargs["api_key"]))
            if path.endswith("trade-bias"):
                return {"direction": "short"}
            if path.endswith("summary"):
                return {"symbol": "SPY"}
            if path.endswith("/basic"):
                return {"signals": {}}
            if path.endswith("/score"):
                return {"composite_score": 55, "components": {}}
            if path.endswith("/quote"):
                return {
                    "timestamp": "2026-07-27T16:00:00Z",
                    "symbol": "SPY",
                    "close": "738.00",
                }
            if path.endswith("/historical"):
                return [
                    {
                        "timestamp": "2026-07-27T15:59:00Z",
                        "symbol": "SPY",
                        "open": "737.90",
                        "high": "738.10",
                        "low": "737.80",
                        "close": "738.00",
                        "volume": 1000,
                    }
                ]
            return {"action": "STAND_DOWN", "near_misses": []}

        snapshot = fetch_snapshot(
            "spy",
            api_key="test-key",
            request_json=request_json,
            include_extended=False,
        )

        self.assertCountEqual(
            [path for path, _, _ in calls],
            [
                "/api/v2/signals/trade-bias",
                "/api/v2/gex/summary",
                "/api/v2/signals/basic",
                "/api/v2/signals/score",
                "/api/v2/signals/action",
                "/api/v2/market/quote",
                "/api/v2/market/historical",
            ],
        )
        self.assertTrue(all(key == "test-key" for _, _, key in calls))
        self.assertEqual(snapshot["symbol"], "SPY")
        self.assertEqual(snapshot["playbook"]["state"], "stand_down")
        self.assertEqual(snapshot["market_quote"]["close"], "738.00")
        self.assertEqual(len(snapshot["market_bars"]), 1)

    def test_market_bars_are_compact_and_sorted(self) -> None:
        snapshot = normalize_snapshot(
            "SPY",
            {},
            {"symbol": "SPY"},
            {"signals": {}},
            market_bars=[
                {
                    "timestamp": "2026-07-27T14:31:00Z",
                    "symbol": "SPY",
                    "close": "738.20",
                    "secret": "drop",
                },
                {
                    "timestamp": "2026-07-27T14:30:00Z",
                    "symbol": "SPY",
                    "close": "738.00",
                },
            ],
        )
        self.assertEqual(
            [bar["timestamp"] for bar in snapshot["market_bars"]],
            ["2026-07-27T14:30:00Z", "2026-07-27T14:31:00Z"],
        )
        self.assertNotIn("secret", snapshot["market_bars"][1])

    def test_extended_fetch_covers_all_advanced_sources(self) -> None:
        calls = []

        def request_json(path, params, **kwargs):
            calls.append(path)
            if path.endswith("summary"):
                return {"symbol": "SPY"}
            if path.endswith("/basic"):
                return {"signals": {}}
            if path.endswith("/score"):
                return {"composite_score": 55, "components": {}}
            if path.endswith("/action"):
                return {"action": "STAND_DOWN", "near_misses": []}
            if path.endswith("historical-context"):
                return {"metrics": {}}
            return {}

        fetch_snapshot(
            "SPY",
            api_key="test-key",
            request_json=request_json,
            include_extended=True,
        )

        self.assertTrue(
            set("/api/v2/" + p[len("/api/"):] for p in ADVANCED_ENDPOINTS.values()).issubset(set(calls))
        )
        self.assertIn("/api/v2/gex/historical-context", calls)
        self.assertIn("/api/v2/market/volatility", calls)
        self.assertIn("/api/v2/gex/strike-profile-timeseries", calls)
        self.assertIn("/api/v2/flow/series", calls)
        self.assertIn("/api/v2/flow/smart-money", calls)
        self.assertIn("/api/v2/market/session-levels", calls)
        self.assertIn("/api/v2/technicals/dealer-hedging", calls)
        self.assertIn("/api/v2/forced-flow/levels", calls)

    def test_deep_fetch_maps_underlying_to_volatility_index(self) -> None:
        for symbol, expected_index in (("SPY", "VIX"), ("QQQ", "VXN")):
            with self.subTest(symbol=symbol):
                volatility_params = []

                def request_json(path, params, **kwargs):
                    if path == "/api/v2/market/volatility":
                        volatility_params.append(params)
                        return {
                            "timestamp": "2026-08-05T14:00:00Z",
                            "index": expected_index,
                            "level": 4,
                            "momentum": 3,
                        }
                    return {}

                snapshot = fetch_component_snapshot(
                    symbol,
                    lane="deep",
                    api_key="test-key",
                    request_json=request_json,
                )

                self.assertEqual(
                    volatility_params,
                    [{"ticker": expected_index}],
                )
                self.assertEqual(
                    snapshot["market_volatility"]["index"],
                    expected_index,
                )

    def test_deep_fetch_accepts_numeric_volatility_index(self) -> None:
        # The provider stopped echoing the ticker name: `index` is now the
        # numeric reading, so identity can't be cross-checked from the body.
        def request_json(path, params, **kwargs):
            if path == "/api/v2/market/volatility":
                return {
                    "timestamp": "2026-08-27T12:10:00-04:00",
                    "index": 14.49,
                    "level": 2.3,
                    "level_label": "Low",
                    "momentum": 3.03,
                    "momentum_label": "Easing",
                }
            return {}

        snapshot = fetch_component_snapshot(
            "SPY",
            lane="deep",
            api_key="test-key",
            request_json=request_json,
        )
        self.assertNotIn("market_volatility", snapshot["endpoint_errors"])
        self.assertEqual(snapshot["market_volatility"]["index"], 14.49)
        self.assertEqual(snapshot["market_volatility"]["index_name"], "VIX")

    def test_deep_fetch_rejects_mismatched_volatility_index(self) -> None:
        def request_json(path, params, **kwargs):
            if path == "/api/v2/market/volatility":
                return {
                    "timestamp": "2026-08-05T14:00:00Z",
                    "index": "VIX",
                    "level": 8,
                    "momentum": 7,
                }
            return {}

        snapshot = fetch_component_snapshot(
            "QQQ",
            lane="deep",
            api_key="test-key",
            request_json=request_json,
            previous_snapshot={
                "market_volatility": {
                    "timestamp": "2026-08-05T13:59:00Z",
                    "index": "VXN",
                    "level": 4,
                    "momentum": 3,
                }
            },
        )

        self.assertEqual(snapshot["market_volatility"]["index"], "VXN")
        self.assertEqual(snapshot["market_volatility"]["level"], 4)
        self.assertIn(
            "returned volatility index VIX for QQQ; expected VXN",
            snapshot["endpoint_errors"]["market_volatility"],
        )

    def test_component_fetches_keep_polling_lanes_independent(self) -> None:
        calls = []

        def request_json(path, params, **kwargs):
            calls.append(path)
            if path.endswith("/summary"):
                return {"symbol": "SPY", "call_wall": 740}
            if path.endswith("/basic"):
                return {"signals": {}}
            if path.endswith("/historical"):
                return []
            return {}

        fast = fetch_component_snapshot(
            "SPY",
            lane="gex",
            api_key="test-key",
            request_json=request_json,
        )
        self.assertEqual(calls, ["/api/v2/gex/summary"])
        self.assertEqual(fast["gex_summary"]["call_wall"], 740)
        self.assertEqual(fast["_fetched_components"], ["gex_summary"])

        calls.clear()
        core = fetch_component_snapshot(
            "SPY",
            lane="core",
            api_key="test-key",
            request_json=request_json,
        )
        self.assertNotIn("/api/v2/gex/summary", calls)
        self.assertNotIn("/api/v2/gex/historical-context", calls)
        self.assertIn("/api/v2/signals/trade-bias", calls)
        self.assertIn("/api/v2/market/historical", calls)
        self.assertNotIn("gex_summary", core["_fetched_components"])

        calls.clear()
        deep = fetch_component_snapshot(
            "SPY",
            lane="deep",
            api_key="test-key",
            request_json=request_json,
        )
        self.assertNotIn("/api/v2/gex/summary", calls)
        self.assertNotIn("/api/v2/signals/trade-bias", calls)
        self.assertIn("/api/v2/gex/historical-context", calls)
        self.assertIn("/api/v2/gex/strike-profile-timeseries", calls)
        self.assertNotIn("gex_summary", deep["_fetched_components"])

    def test_component_fetch_rejects_unknown_lane(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown ZeroGEX polling lane"):
            fetch_component_snapshot(
                "SPY",
                lane="hourly",
                api_key="test-key",
                request_json=lambda *args, **kwargs: {},
            )

    def test_normalizes_structure_flow_and_session_context(self) -> None:
        snapshot = normalize_snapshot(
            "SPY",
            {},
            {
                "symbol": "SPY",
                "gamma_flip": 738,
                "call_wall": 740,
                "put_wall": 735,
            },
            {"signals": {}},
            strike_profile=[
                {
                    "timestamp": "2026-07-28T14:00:00Z",
                    "close": 738,
                    "call_wall": 739,
                    "put_wall": 735,
                    "gamma_flip": 737.5,
                    "strikes": [
                        {
                            "strike": 739,
                            "net_gamma": 100,
                            "call_gamma": 100,
                            "put_gamma": -10,
                        }
                    ],
                },
                {
                    "timestamp": "2026-07-28T14:19:00Z",
                    "close": 739,
                    "call_wall": 740,
                    "put_wall": 735,
                    "gamma_flip": 738,
                    "strikes": [
                        {
                            "strike": 739,
                            "net_gamma": 140,
                            "call_gamma": 140,
                            "put_gamma": -10,
                        },
                        {
                            "strike": 740,
                            "net_gamma": 180,
                            "call_gamma": 180,
                            "put_gamma": -5,
                        },
                    ],
                },
            ],
            flow_series=[
                {
                    "timestamp": "2026-07-28T14:19:00Z",
                    "call_premium_cum": 800,
                    "put_premium_cum": 200,
                    "net_premium_cum": 600,
                }
            ],
            smart_money=[
                {
                    "timestamp": "2026-07-28T14:19:00Z",
                    "option_type": "C",
                    "trade_side": "BUY",
                    "notional": 1000,
                }
            ],
            session_levels={
                "premarket_high": 739.5,
                "premarket_low": 736.5,
                "prev_session_high": 741,
                "prev_session_low": 735,
                "updated_at": "2026-07-28T14:19:00Z",
            },
            technicals={
                "bars": [
                    {
                        "timestamp": "2026-07-28T14:19:00Z",
                        "opening_range": {"orb_high": 739, "orb_low": 737},
                        "momentum_divergence": {
                            "divergence_signal": "bullish confirmation"
                        },
                    }
                ]
            },
            dealer_hedging=[
                {
                    "timestamp": "2026-07-28T14:19:00Z",
                    "expected_hedge_shares": -2_000_000,
                    "hedge_pressure": "buy",
                }
            ],
            forced_flow_levels={
                "timestamp": "2026-07-28T14:19:00Z",
                "zero_flow_level": 738.5,
            },
        )
        self.assertEqual(snapshot["strike_context"]["status"], "ok")
        self.assertEqual(
            snapshot["strike_context"]["wall_strength"]["call"]["strike"],
            740,
        )
        self.assertEqual(snapshot["flow_context"]["direction"], "calls")
        self.assertTrue(snapshot["flow_context"]["aligned"])
        self.assertEqual(
            snapshot["session_context"]["opening_range"]["orb_high"],
            739,
        )
        self.assertEqual(
            snapshot["dealer_hedging"]["expected_hedge_shares"],
            -2_000_000,
        )
        self.assertEqual(snapshot["forced_flow"]["zero_flow_level"], 738.5)

    def test_api_key_can_be_read_from_env_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("ZEROGEX_API_KEY='local-test-key'\n")
            with patch.dict(os.environ, {"ZEROGEX_API_KEY": ""}):
                self.assertEqual(get_api_key(env_file), "local-test-key")

    def test_missing_api_key_has_safe_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"ZEROGEX_API_KEY": ""}):
                with self.assertRaises(ZeroGEXAuthError) as raised:
                    get_api_key(Path(directory) / ".env")
        self.assertNotIn("Bearer", str(raised.exception))

    def test_text_output_is_explicitly_read_only_analytics(self) -> None:
        text = render_text(
            {
                "symbol": "SPY",
                "trade_bias": {
                    "direction": "short",
                    "bias_score": -60.95,
                    "confidence": 52.42,
                },
                "gex_summary": {
                    "gamma_flip": 747.66,
                    "put_wall": 740.0,
                    "call_wall": 745.0,
                },
                "advanced_signals": {
                    "vol_expansion": {
                        "expansion": 80.0,
                        "direction_score": -75.0,
                    }
                },
            }
        )
        self.assertIn("ZEROGEX ANALYTICS", text)
        self.assertIn("SHORT", text)
        self.assertIn("advanced=vol_expansion", text)
        self.assertNotIn("test-key", text)


class ZeroGEXV2EnvelopeTest(unittest.TestCase):
    def test_v2_envelope_is_unwrapped_and_freshness_kept(self) -> None:
        def request_json(path, params, **kwargs):
            self.assertTrue(path.startswith("/api/v2/"))
            if path.endswith("/summary"):
                return {
                    "data": {
                        "symbol": "SPY",
                        "call_wall": 740,
                        "pin_strike": 741.0,
                        "pin_score": 0.8,
                    },
                    "freshness": {
                        "freshness_status": "fresh",
                        "age_seconds": 12.0,
                        "source_timestamp": "2026-08-27T15:56:00Z",
                        "stale_after": "2026-08-27T15:58:30Z",
                        "expected_update_cadence_seconds": 60.0,
                        "evaluated_at": "2026-08-27T15:56:12Z",
                        "cadence_profile": "dropped",
                    },
                }
            return {}

        snapshot = fetch_component_snapshot(
            "SPY", lane="gex", api_key="k", request_json=request_json
        )
        self.assertEqual(snapshot["gex_summary"]["call_wall"], 740)
        self.assertEqual(snapshot["gex_summary"]["pin_strike"], 741.0)
        entry = snapshot["freshness"]["gex_summary"]
        self.assertEqual(entry["freshness_status"], "fresh")
        self.assertEqual(entry["stale_after"], "2026-08-27T15:58:30Z")
        self.assertNotIn("cadence_profile", entry)

    def test_v1_bodies_pass_through_without_freshness(self) -> None:
        def request_json(path, params, **kwargs):
            if path.endswith("/summary"):
                return {"symbol": "SPY", "call_wall": 740}
            return {}

        snapshot = fetch_component_snapshot(
            "SPY", lane="gex", api_key="k", request_json=request_json
        )
        self.assertEqual(snapshot["gex_summary"]["call_wall"], 740)
        self.assertEqual(snapshot["freshness"], {})

    def test_missing_v2_endpoint_falls_back_to_v1(self) -> None:
        calls = []

        def request_json(path, params, **kwargs):
            calls.append(path)
            if path == "/api/v2/gex/summary":
                raise ZeroGEXError(
                    "ZeroGEX request failed (HTTP 404)", status=404
                )
            if path == "/api/gex/summary":
                return {"symbol": "SPY", "call_wall": 740}
            return {}

        snapshot = fetch_component_snapshot(
            "SPY", lane="gex", api_key="k", request_json=request_json
        )
        self.assertEqual(calls, ["/api/v2/gex/summary", "/api/gex/summary"])
        self.assertEqual(snapshot["gex_summary"]["call_wall"], 740)

    def test_non_404_errors_do_not_fall_back_to_v1(self) -> None:
        calls = []

        def request_json(path, params, **kwargs):
            calls.append(path)
            raise ZeroGEXError("ZeroGEX request failed (HTTP 500)", status=500)

        with self.assertRaises(ZeroGEXError):
            fetch_component_snapshot(
                "SPY", lane="gex", api_key="k", request_json=request_json
            )
        self.assertEqual(calls, ["/api/v2/gex/summary"])

    def test_carried_forward_component_keeps_prior_freshness(self) -> None:
        def request_json(path, params, **kwargs):
            if path.endswith("/dealer-hedging"):
                raise ZeroGEXError(
                    "ZeroGEX request failed (HTTP 500)", status=500
                )
            return {}

        previous = {
            "dealer_hedging": {"hedge_pressure": "Balanced"},
            "freshness": {
                "dealer_hedging": {
                    "freshness_status": "fresh",
                    "source_timestamp": "2026-08-27T15:55:00Z",
                }
            },
        }
        snapshot = fetch_component_snapshot(
            "SPY",
            lane="deep",
            api_key="k",
            request_json=request_json,
            previous_snapshot=previous,
        )
        self.assertEqual(
            snapshot["dealer_hedging"]["hedge_pressure"], "Balanced"
        )
        entry = snapshot["freshness"]["dealer_hedging"]
        self.assertTrue(entry["carried_forward"])
        self.assertEqual(entry["freshness_status"], "fresh")


class ZeroGEXNewComponentTest(unittest.TestCase):
    def test_deep_lane_fetches_rolloff_and_flip_horizons(self) -> None:
        calls = []

        def request_json(path, params, **kwargs):
            calls.append((path, dict(params)))
            if path.endswith("/expiry-rolloff"):
                return {
                    "symbol": "SPY",
                    "as_of": "2026-08-27T15:10:00+00:00",
                    "session_date": "2026-08-27",
                    "spot": 770.55,
                    "total_abs_gex": 11.2e9,
                    "total_net_gex": 3.5e9,
                    "next": {
                        "expiration": "2026-08-27",
                        "dte": 0,
                        "net_gex": 2.4e9,
                        "abs_gex": 3.2e9,
                        "share": 0.285,
                    },
                    "context": {
                        "percentile": None,
                        "verdict": None,
                        "sessions_in_window": 0,
                    },
                    "tranches": [
                        {"expiration": "2026-08-27", "dte": 0, "net_gex": 2.4e9, "abs_gex": 3.2e9, "share": 0.285, "noise": 1},
                        {"expiration": "2026-08-28", "dte": 1, "net_gex": 1.4e9, "abs_gex": 2.7e9, "share": 0.239},
                    ],
                }
            if path.endswith("/flip-term-structure"):
                return {
                    "symbol": "SPY",
                    "spot": 772.2,
                    "timestamp": "2026-08-27T16:40:00+00:00",
                    "horizons_days": [1.0, 3.0, 5.0, 10.0],
                    "curve": [
                        {"horizon_days": 1.0, "flip": 769.0, "resolved": True, "span_used": 0.2, "net_gex_at_spot": 2.8e9},
                        {"horizon_days": 3.0, "flip": 770.27, "resolved": True, "net_gex_at_spot": 2.4e9},
                    ],
                    "historical": [{"horizon_days": 1.0, "realized_at": "..."}],
                }
            return {}

        snapshot = fetch_component_snapshot(
            "SPY", lane="deep", api_key="k", request_json=request_json
        )

        paths = [path for path, _ in calls]
        self.assertIn("/api/v2/gex/expiry-rolloff", paths)
        self.assertIn("/api/v2/gex/flip-term-structure", paths)
        self.assertNotIn("/api/v2/gex/regime-shift", paths)

        rolloff = snapshot["expiry_rolloff"]
        self.assertEqual(rolloff["zero_dte_share"], 0.285)
        self.assertEqual(rolloff["one_dte_share"], 0.239)
        self.assertEqual(rolloff["next"]["dte"], 0)
        self.assertEqual(rolloff["timestamp"], "2026-08-27T15:10:00+00:00")
        self.assertNotIn("noise", rolloff["tranches"][0])

        horizons = snapshot["flip_horizons"]
        self.assertEqual(horizons["spot"], 772.2)
        self.assertEqual(horizons["curve"][0]["flip"], 769.0)
        self.assertNotIn("span_used", horizons["curve"][0])
        self.assertNotIn("historical", horizons)

    def test_slow_lane_fetches_only_regime_shift(self) -> None:
        calls = []

        def request_json(path, params, **kwargs):
            calls.append((path, dict(params)))
            if path.endswith("/regime-shift"):
                return {
                    "symbol": "SPY",
                    "lookback": "session",
                    "lens": "positioning",
                    "session_date": "2026-08-27",
                    "from": {"timestamp": "2026-08-27T13:30:00+00:00", "gamma_flip": 769.07, "spot": 768.65},
                    "to": {"timestamp": "2026-08-27T15:10:00+00:00", "gamma_flip": 769.56, "spot": 770.55},
                    "read": {
                        "state": "QUIET",
                        "adverb": "barely",
                        "lean_z": 0.0,
                        "stability_z": 0.0,
                        "magnitude": 0.0,
                        "meaning": "No meaningful repositioning.",
                        "normalization": "proxy",
                        "sessions_in_window": 0,
                    },
                    "scores": {"lean": -1.04, "stability": 0.99},
                    "strikes": [{"strike": 770, "delta_gex": 1.0}],
                    "band": {},
                }
            return {}

        snapshot = fetch_component_snapshot(
            "SPY", lane="slow", api_key="k", request_json=request_json
        )

        self.assertEqual(
            [path for path, _ in calls], ["/api/v2/gex/regime-shift"]
        )
        self.assertEqual(calls[0][1]["lens"], "positioning")
        shift = snapshot["regime_shift"]
        self.assertEqual(shift["read"]["state"], "QUIET")
        self.assertEqual(shift["timestamp"], "2026-08-27T15:10:00+00:00")
        self.assertEqual(shift["to"]["gamma_flip"], 769.56)
        self.assertNotIn("strikes", shift)
        self.assertEqual(snapshot["_fetched_components"], ["regime_shift"])


if __name__ == "__main__":
    unittest.main()
