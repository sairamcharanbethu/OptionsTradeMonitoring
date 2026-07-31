#!/usr/bin/env python3

import unittest
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from trade_prefetch_service import (
    TradePrefetcher,
    _bars_are_stale,
    _compact_shadow_gex,
    _configured_primary_gex,
    _latest_completed_bar_time,
    _locked_option_expiry,
    _locked_option_spec,
    _preferred_option_expiry,
    _ticker_time,
    _zerogex_primary_snapshot,
)


class TradePrefetchHelpersTest(unittest.TestCase):
    @patch("trade_prefetch_service.redis_client")
    def test_strategy_snapshot_notification_publishes_small_redis_event(
        self,
        redis_module,
    ) -> None:
        publisher = Mock()
        redis_module.Redis.from_url.return_value = publisher
        prefetcher = TradePrefetcher.__new__(TradePrefetcher)
        prefetcher.args = SimpleNamespace(
            redis_url="redis://redis:6379",
            redis_channel="strategy:state-changed",
        )
        prefetcher.redis_publisher = None
        prefetcher.redis_retry_at = 0.0
        prefetcher.redis_last_error_at = 0.0

        prefetcher._publish_signal_update({
            "generated_at": 1000.25,
            "state": "ACTIVE",
            "signal_phase": "ACTIVE",
            "large_payload": "not-published",
        })

        channel, raw = publisher.publish.call_args.args
        payload = json.loads(raw)
        self.assertEqual(channel, "strategy:state-changed")
        self.assertEqual(payload["state"], "ACTIVE")
        self.assertNotIn("large_payload", payload)

    def test_zerogex_primary_maps_to_engine_gex_contract(self) -> None:
        now = 1_785_162_000.0
        provider_time = datetime.fromtimestamp(
            now - 30, timezone.utc
        ).isoformat()
        snapshot = {
            "fetched_at": now - 5,
            "source": "zerogex",
            "symbol": "SPY",
            "trade_bias": {
                "timestamp": datetime.fromtimestamp(
                    now - 5, timezone.utc
                ).isoformat(),
            },
            "gex_summary": {
                "timestamp": provider_time,
                "spot_price": 741.5,
                "gamma_flip": 747.66,
                "call_wall": 745.0,
                "put_wall": 740.0,
                "net_gex": -3_800_000_000,
            },
        }

        normalized = _zerogex_primary_snapshot(snapshot, now=now)
        spy = normalized["data"]["SPY"]
        self.assertEqual(normalized["selected_source"], "zerogex")
        self.assertEqual(spy["regime"], "Negative")
        self.assertEqual(spy["gamma_regime"], "Trend")
        self.assertEqual(spy["flip"], 747.66)
        self.assertEqual(spy["call_wall"]["strike"], 745.0)
        self.assertNotIn("error", spy)

    def test_stale_zerogex_provider_data_is_not_usable_as_primary(self) -> None:
        now = 1_785_162_000.0
        snapshot = {
            "fetched_at": now - 5,
            "source": "zerogex",
            "symbol": "SPY",
            "trade_bias": {
                "timestamp": datetime.fromtimestamp(
                    now - 5, timezone.utc
                ).isoformat(),
            },
            "gex_summary": {
                "timestamp": datetime.fromtimestamp(
                    now - 240, timezone.utc
                ).isoformat(),
                "spot_price": 741.5,
                "gamma_flip": 747.66,
                "call_wall": 745.0,
                "put_wall": 740.0,
                "net_gex": -3_800_000_000,
            },
        }

        normalized = _zerogex_primary_snapshot(
            snapshot,
            now=now,
            max_provider_age=120,
        )
        self.assertIn("old", normalized["data"]["SPY"]["error"])
        self.assertEqual(
            normalized["data"]["SPY"]["provider_raw_age_seconds"],
            240.0,
        )
        self.assertEqual(
            normalized["data"]["SPY"]["provider_age_seconds"],
            180.0,
        )

    def test_minute_bucket_precision_does_not_create_false_stale_gex(self) -> None:
        now = 1_785_162_008.0
        snapshot = {
            "fetched_at": now - 2,
            "source": "zerogex",
            "symbol": "SPY",
            "gex_summary": {
                "timestamp": datetime.fromtimestamp(
                    now - 128, timezone.utc
                ).isoformat(),
                "spot_price": 741.5,
                "gamma_flip": 747.66,
                "call_wall": 745.0,
                "put_wall": 740.0,
                "net_gex": -3_800_000_000,
            },
        }

        normalized = _zerogex_primary_snapshot(snapshot, now=now)
        spy = normalized["data"]["SPY"]
        self.assertNotIn("error", spy)
        self.assertEqual(spy["provider_raw_age_seconds"], 128.0)
        self.assertEqual(spy["provider_age_seconds"], 68.0)
        self.assertEqual(
            spy["provider_timestamp_precision_grace_seconds"],
            60.0,
        )

    def test_second_precision_timestamp_gets_no_bucket_allowance(self) -> None:
        now = 1_785_162_000.0
        snapshot = {
            "fetched_at": now - 2,
            "source": "zerogex",
            "symbol": "SPY",
            "gex_summary": {
                "timestamp": datetime.fromtimestamp(
                    now - 121, timezone.utc
                ).isoformat(),
                "spot_price": 741.5,
                "gamma_flip": 747.66,
                "call_wall": 745.0,
                "put_wall": 740.0,
                "net_gex": -3_800_000_000,
            },
        }

        normalized = _zerogex_primary_snapshot(snapshot, now=now)
        spy = normalized["data"]["SPY"]
        self.assertIn("old", spy["error"])
        self.assertEqual(
            spy["provider_timestamp_precision_grace_seconds"],
            0.0,
        )

    def test_configured_primary_does_not_silently_fallback(self) -> None:
        now = 1_785_162_000.0
        local = {
            "fetched_at": now,
            "source": "ibkr-local-oi-model",
            "data": {"SPY": {"regime": "Positive", "gamma_regime": "Range"}},
        }
        selected = _configured_primary_gex(
            "zerogex",
            sscgex=None,
            local=local,
            zerogex=None,
            zerogex_max_provider_age=120,
            now=now,
        )
        self.assertEqual(selected["selected_source"], "zerogex")
        self.assertIn("no snapshot", selected["data"]["SPY"]["error"])

    def test_shadow_snapshot_is_explicitly_non_authoritative(self) -> None:
        now = 1_785_162_000.0
        snapshot = {
            "fetched_at": now - 2,
            "source": "sscgex",
            "data": {
                "SPY": {
                    "regime": "Positive",
                    "gamma_regime": "Range",
                    "call_wall": {"strike": 745.0},
                    "put_wall": {"strike": 740.0},
                }
            },
        }
        shadow = _compact_shadow_gex(
            snapshot,
            source="sscgex",
            now=now,
            max_age=20,
        )
        self.assertTrue(shadow["fresh"])
        self.assertFalse(shadow["entry_authority"])
        self.assertEqual(shadow["mode"], "shadow")

    def test_expiry_rolls_from_today_to_next_listed_at_1pm_et(self) -> None:
        et = ZoneInfo("America/New_York")
        expirations = ["20260722", "20260723", "20260724"]
        before = datetime(2026, 7, 22, 12, 59, 59, tzinfo=et).timestamp()
        after = datetime(2026, 7, 22, 13, 0, 0, tzinfo=et).timestamp()
        self.assertEqual(
            _preferred_option_expiry(expirations, before),
            ("20260722", "0DTE"),
        )
        self.assertEqual(
            _preferred_option_expiry(expirations, after),
            ("20260723", "1DTE_NEXT_LISTED"),
        )

    def test_after_1pm_uses_next_listed_expiry_across_weekend(self) -> None:
        et = ZoneInfo("America/New_York")
        friday_after = datetime(2026, 7, 24, 13, 0, tzinfo=et).timestamp()
        self.assertEqual(
            _preferred_option_expiry(["20260724", "20260727"], friday_after),
            ("20260727", "1DTE_NEXT_LISTED"),
        )

    def test_active_position_preserves_activation_expiry(self) -> None:
        active = {
            "state": "ACTIVE",
            "favoring": "puts",
            "put_setup": {"option": {"expiry": "20260722"}},
        }
        self.assertEqual(_locked_option_expiry(active), "20260722")
        active["state"] = "WAIT"
        self.assertIsNone(_locked_option_expiry(active))

    def test_flat_prefetcher_recenters_to_next_expiry_after_1pm(self) -> None:
        et = ZoneInfo("America/New_York")
        after = datetime(2026, 7, 22, 13, 0, tzinfo=et).timestamp()
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            (output_dir / "signal.json").write_text(json.dumps({"state": "WAIT"}))
            prefetcher = TradePrefetcher.__new__(TradePrefetcher)
            prefetcher.option_tickers = [SimpleNamespace()]
            prefetcher.option_anchor_spot = 748.0
            prefetcher.option_expiry = "20260722"
            prefetcher.option_chain = SimpleNamespace(
                expirations={"20260722", "20260723"}
            )
            prefetcher.args = SimpleNamespace(
                output_dir=output_dir,
                option_recenter=2.0,
            )
            prefetcher._option_anchor_price = Mock(return_value=748.0)
            with patch("trade_prefetch_service.time.time", return_value=after):
                self.assertTrue(prefetcher._options_need_recenter())

    def test_active_zero_dte_position_prevents_1pm_expiry_recenter(self) -> None:
        et = ZoneInfo("America/New_York")
        after = datetime(2026, 7, 22, 13, 0, tzinfo=et).timestamp()
        active = {
            "state": "ACTIVE",
            "favoring": "calls",
            "call_setup": {"option": {"expiry": "20260722"}},
        }
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            (output_dir / "signal.json").write_text(json.dumps(active))
            prefetcher = TradePrefetcher.__new__(TradePrefetcher)
            prefetcher.option_tickers = [SimpleNamespace()]
            prefetcher.option_anchor_spot = 748.0
            prefetcher.option_expiry = "20260722"
            prefetcher.option_chain = SimpleNamespace(
                expirations={"20260722", "20260723"}
            )
            prefetcher.args = SimpleNamespace(
                output_dir=output_dir,
                option_recenter=2.0,
            )
            prefetcher._option_anchor_price = Mock(return_value=748.0)
            with patch("trade_prefetch_service.time.time", return_value=after):
                self.assertFalse(prefetcher._options_need_recenter())

    def test_open_continuation_retains_activation_contract_subscription(self) -> None:
        signal = {
            "state": "MANAGE",
            "strategy": "CONTINUATION",
            "favoring": "calls",
            "call_setup": {
                "option": {"expiry": "20260721", "target_strike": 747.0, "right": "C"}
            },
        }
        self.assertEqual(_locked_option_spec(signal, "20260721"), (747.0, "C"))

    def test_closed_signal_does_not_retain_option_subscription(self) -> None:
        signal = {
            "state": "WAIT",
            "strategy": "CONTINUATION",
            "favoring": "calls",
            "call_setup": {
                "option": {"expiry": "20260721", "target_strike": 747.0, "right": "C"}
            },
        }
        self.assertIsNone(_locked_option_spec(signal, "20260721"))

    def test_open_mtf_position_retains_activation_contract_subscription(self) -> None:
        signal = {
            "state": "ACTIVE",
            "strategy": "MTF_REVERSAL",
            "favoring": "puts",
            "put_setup": {
                "option": {"expiry": "20260721", "target_strike": 746.0, "right": "P"}
            },
        }
        self.assertEqual(_locked_option_spec(signal, "20260721"), (746.0, "P"))

    def test_open_gex_rejection_retains_activation_contract_subscription(self) -> None:
        signal = {
            "state": "ACTIVE",
            "strategy": "GEX_REJECTION",
            "favoring": "calls",
            "call_setup": {
                "option": {"expiry": "20260721", "target_strike": 747.0, "right": "C"}
            },
        }
        self.assertEqual(_locked_option_spec(signal, "20260721"), (747.0, "C"))

    def test_ticker_time_returns_epoch_seconds(self) -> None:
        stamp = datetime(2026, 7, 20, 17, 0, tzinfo=timezone.utc)
        self.assertEqual(_ticker_time(SimpleNamespace(time=stamp)), stamp.timestamp())

    def test_ticker_time_handles_missing_value(self) -> None:
        self.assertIsNone(_ticker_time(SimpleNamespace(time=None)))

    def test_latest_completed_bar_excludes_current_minute(self) -> None:
        now = 1_000.0
        bars = [SimpleNamespace(date=900.0), SimpleNamespace(date=960.0)]
        self.assertEqual(_latest_completed_bar_time(bars, now), 900.0)

    def test_stale_bar_detection(self) -> None:
        bars = [SimpleNamespace(date=840.0)]
        self.assertTrue(_bars_are_stale(bars, stale_after=125, now=1_000.0))
        self.assertFalse(_bars_are_stale(bars, stale_after=180, now=1_000.0))

    def test_stale_subscription_is_resubscribed(self) -> None:
        prefetcher = TradePrefetcher.__new__(TradePrefetcher)
        prefetcher.args = SimpleNamespace(
            symbols=["SPY"],
            bar_stale_after=125,
            bar_recovery_cooldown=30,
        )
        prefetcher.bars = {"SPY": [SimpleNamespace(date=840.0)]}
        prefetcher.last_bar_refresh = 0.0
        prefetcher.bar_refresh_required = True
        prefetcher.last_bar_recovery_reason = "HMDS data farm disconnected"
        prefetcher._subscribe_bars = Mock()

        with patch("trade_prefetch_service.time.time", return_value=1_000.0), patch(
            "trade_prefetch_service._regular_session_open", return_value=True
        ):
            prefetcher._recover_stale_bars()

        prefetcher._subscribe_bars.assert_called_once_with("SPY")
        self.assertFalse(prefetcher.bar_refresh_required)
        self.assertIsNone(prefetcher.last_bar_recovery_reason)

    def test_stale_subscription_is_not_recovered_after_hours(self) -> None:
        prefetcher = TradePrefetcher.__new__(TradePrefetcher)
        prefetcher.args = SimpleNamespace(
            symbols=["SPY"],
            bar_stale_after=125,
            bar_recovery_cooldown=30,
        )
        prefetcher.bars = {"SPY": [SimpleNamespace(date=840.0)]}
        prefetcher.last_bar_refresh = 0.0
        prefetcher.bar_refresh_required = True
        prefetcher.last_bar_recovery_reason = "HMDS data farm disconnected"
        prefetcher._subscribe_bars = Mock()

        with patch("trade_prefetch_service.time.time", return_value=1_000.0), patch(
            "trade_prefetch_service._regular_session_open", return_value=False
        ):
            prefetcher._recover_stale_bars()

        prefetcher._subscribe_bars.assert_not_called()
        self.assertFalse(prefetcher.bar_refresh_required)
        self.assertIsNone(prefetcher.last_bar_recovery_reason)

    def test_option_anchor_falls_back_to_latest_ibkr_bar(self) -> None:
        prefetcher = TradePrefetcher.__new__(TradePrefetcher)
        prefetcher.tickers = {"SPY": SimpleNamespace()}
        prefetcher.bars = {"SPY": [SimpleNamespace(close=748.25)]}
        prefetcher.args = SimpleNamespace(gex_file=SimpleNamespace())
        with patch("trade_prefetch_service._ticker_price", side_effect=RuntimeError("no quote")):
            self.assertEqual(prefetcher._option_anchor_price(), 748.25)

    def test_option_anchor_falls_back_to_primary_gex_spot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gex.json"
            path.write_text(json.dumps({"data": {"SPY": {"spot": 748.5}}}))
            prefetcher = TradePrefetcher.__new__(TradePrefetcher)
            prefetcher.tickers = {"SPY": SimpleNamespace()}
            prefetcher.bars = {"SPY": []}
            prefetcher.args = SimpleNamespace(gex_file=path)
            with patch("trade_prefetch_service._ticker_price", side_effect=RuntimeError("no quote")):
                self.assertEqual(prefetcher._option_anchor_price(), 748.5)

    def test_reconnect_reset_discards_connection_bound_option_tickers(self) -> None:
        prefetcher = TradePrefetcher.__new__(TradePrefetcher)
        prefetcher.option_tickers = [SimpleNamespace(stale=True)]
        prefetcher.option_chain = SimpleNamespace(expirations={"20260727"})
        prefetcher.option_expiry = "20260727"
        prefetcher.option_expiry_mode = "1DTE_NEXT_LISTED"
        prefetcher.option_anchor_spot = 740.0
        prefetcher.last_option_refresh = 123.0

        prefetcher._reset_option_state()

        self.assertEqual(prefetcher.option_tickers, [])
        self.assertIsNone(prefetcher.option_chain)
        self.assertIsNone(prefetcher.option_expiry)
        self.assertIsNone(prefetcher.option_expiry_mode)
        self.assertIsNone(prefetcher.option_anchor_spot)
        self.assertEqual(prefetcher.last_option_refresh, 0.0)

    def test_signal_history_journal_compacts_zerogex_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            prefetcher = TradePrefetcher.__new__(TradePrefetcher)
            prefetcher.args = SimpleNamespace(
                output_dir=output_dir,
                journal_interval=60,
            )
            prefetcher.last_journal_fingerprint = None
            prefetcher.last_journal_at = 0.0
            prefetcher._signal_fingerprint = Mock(return_value="test")
            signal = {
                "state": "WAIT",
                "zerogex_shadow": {
                    "fresh": True,
                    "advanced_signals": {"raw": "x" * 20_000},
                },
                "zerogex_decision": {
                    "trade_bias": {"side": "puts"},
                    "flow_context": {"raw": "y" * 20_000},
                },
            }
            with patch("trade_prefetch_service.time.time", return_value=1_000):
                prefetcher._journal_signal(signal)
            journal = next((output_dir / "history").glob("signals-*.jsonl"))
            record = json.loads(journal.read_text())
        self.assertNotIn(
            "advanced_signals",
            record["zerogex_shadow"],
        )
        self.assertNotIn(
            "flow_context",
            record["zerogex_decision"],
        )
        self.assertIn("advanced_signals", signal["zerogex_shadow"])

    def test_runtime_ibkr_policy_reconnects_on_admin_config_change(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            policy_file = Path(tmp) / "policy.json"
            policy_file.write_text(json.dumps({
                "ibkr_host": "ib_gateway",
                "ibkr_port": 4004,
                "ibkr_data_type": "delayed",
            }))
            prefetcher = TradePrefetcher.__new__(TradePrefetcher)
            prefetcher.args = SimpleNamespace(
                policy_file=policy_file,
                host="old-host",
                port=4003,
                data_type="live",
            )
            prefetcher.ib = Mock()
            prefetcher.ib.isConnected.return_value = True
            prefetcher._reset_option_state = Mock()

            prefetcher._apply_runtime_ibkr_policy()

            prefetcher.ib.disconnect.assert_called_once()
            prefetcher._reset_option_state.assert_called_once()
            self.assertEqual(prefetcher.args.host, "ib_gateway")
            self.assertEqual(prefetcher.args.port, 4004)
            self.assertEqual(prefetcher.args.data_type, "delayed")


if __name__ == "__main__":
    unittest.main()
