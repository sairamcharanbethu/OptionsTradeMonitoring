#!/usr/bin/env python3

import unittest
from types import SimpleNamespace

from local_gex import GexSourceSelector, build_local_gex, select_gex, usable_gex
from trade_prefetch_service import _option_dict


def contract(right, strike, gamma, oi):
    return {
        "right": right,
        "strike": strike,
        "gamma": gamma,
        "open_interest": oi,
    }


class LocalGexTest(unittest.TestCase):
    def test_explicitly_disabled_primary_selects_local_immediately(self) -> None:
        selector = GexSourceSelector(
            failover_delay=7,
            recovery_delay=3,
            primary_enabled=False,
        )
        local = build_local_gex(
            {
                "expiry": "20260727",
                "contracts": [
                    {
                        "right": right,
                        "strike": strike,
                        "gamma": 0.01,
                        "open_interest": 100,
                    }
                    for strike in (739, 740, 741, 742)
                    for right in ("C", "P")
                ],
            },
            741.0,
            min_contracts=8,
            now=1_000,
        )

        selected = selector.choose(
            None,
            local,
            local_enabled=True,
            now=1_001,
        )

        self.assertEqual(selected["selected_source"], "ibkr-local-oi-model")
        self.assertEqual(selector.status(now=1_001)["selected_source"], "ibkr-local-oi-model")
        self.assertFalse(selector.status(now=1_001)["primary_enabled"])

    def setUp(self):
        self.options = {
            "expiry": "20260722",
            "contracts": [
                contract("C", 101, 0.02, 100),
                contract("C", 102, 0.01, 50),
                contract("P", 99, 0.03, 200),
                contract("P", 98, 0.01, 10),
            ],
        }

    def test_builds_signed_open_interest_gex_and_walls(self):
        snapshot = build_local_gex(self.options, 100.0, min_contracts=4, now=1_000)
        spy = snapshot["data"]["SPY"]
        self.assertNotIn("error", spy)
        self.assertEqual(spy["call_wall"]["strike"], 101.0)
        self.assertEqual(spy["put_wall"]["strike"], 99.0)
        self.assertEqual(spy["net_gex"], -36_000.0)
        self.assertEqual(spy["regime"], "Negative")
        self.assertEqual(spy["gamma_regime"], "Trend")
        self.assertTrue(snapshot["model"]["dealer_position_inferred"])

    def test_incomplete_chain_is_not_usable(self):
        snapshot = build_local_gex(self.options, 100.0, min_contracts=8, now=1_000)
        self.assertIn("error", snapshot["data"]["SPY"])
        self.assertFalse(usable_gex(snapshot, max_age=20, now=1_001))

    def test_low_field_coverage_is_rejected_even_with_enough_open_interest(self):
        options = {
            "expiry": "20260722",
            "contracts": self.options["contracts"]
            + [contract("C", 103, None, None), contract("P", 97, None, None)],
        }
        snapshot = build_local_gex(options, 100.0, min_contracts=4, now=1_000)
        self.assertIn("error", snapshot["data"]["SPY"])
        self.assertIn("coverage=66.7%", snapshot["data"]["SPY"]["error"])

    def test_external_source_remains_primary(self):
        local = build_local_gex(self.options, 100.0, min_contracts=4, now=1_000)
        external = {
            "fetched_at": 1_000,
            "source": "sscgex",
            "data": {"SPY": {"spot": 100, "regime": "Positive", "gamma_regime": "Range"}},
        }
        selected = select_gex(external, local, local_enabled=True, now=1_001)
        self.assertEqual(selected["selected_source"], "sscgex")

    def test_local_source_requires_opt_in_and_primary_failure(self):
        local = build_local_gex(self.options, 100.0, min_contracts=4, now=1_000)
        failed = {
            "fetched_at": 1_000,
            "source": "sscgex",
            "data": {"SPY": {"error": "timeout"}},
        }
        disabled = select_gex(failed, local, local_enabled=False, now=1_001)
        enabled = select_gex(failed, local, local_enabled=True, now=1_001)
        self.assertEqual(disabled["source"], "sscgex")
        self.assertEqual(enabled["selected_source"], "ibkr-local-oi-model")

    def test_source_selector_debounces_failover_and_recovery(self):
        selector = GexSourceSelector(failover_delay=7, recovery_delay=3)
        external = {
            "fetched_at": 1_000,
            "source": "prefetch-service",
            "data": {"SPY": {"spot": 100, "regime": "Positive", "gamma_regime": "Range"}},
        }
        local = build_local_gex(self.options, 100.0, min_contracts=4, now=1_000)
        self.assertEqual(
            selector.choose(external, local, local_enabled=True, now=1_001)["selected_source"],
            "sscgex",
        )

        # The primary crosses its freshness limit, but a short gap does not flip sources.
        local["fetched_at"] = 1_021
        self.assertEqual(
            selector.choose(external, local, local_enabled=True, now=1_021)["selected_source"],
            "sscgex",
        )
        local["fetched_at"] = 1_027
        self.assertEqual(
            selector.choose(external, local, local_enabled=True, now=1_027)["selected_source"],
            "sscgex",
        )
        local["fetched_at"] = 1_028.1
        self.assertEqual(
            selector.choose(external, local, local_enabled=True, now=1_028.1)["selected_source"],
            "ibkr-local-oi-model",
        )

        # One fresh primary write is not enough to switch back immediately.
        external["fetched_at"] = 1_029
        local["fetched_at"] = 1_029
        self.assertEqual(
            selector.choose(external, local, local_enabled=True, now=1_029)["selected_source"],
            "ibkr-local-oi-model",
        )
        external["fetched_at"] = 1_032.1
        local["fetched_at"] = 1_032.1
        self.assertEqual(
            selector.choose(external, local, local_enabled=True, now=1_032.1)["selected_source"],
            "sscgex",
        )

    def test_ibkr_option_serialization_retains_gamma_and_open_interest(self):
        ticker = SimpleNamespace(
            contract=SimpleNamespace(
                localSymbol="SPY C101", right="C", strike=101, lastTradeDateOrContractMonth="20260722"
            ),
            bid=1.0,
            ask=1.02,
            modelGreeks=SimpleNamespace(delta=0.4, gamma=0.023456789),
            bidGreeks=None,
            askGreeks=None,
            lastGreeks=None,
            callOpenInterest=321,
            putOpenInterest=None,
            volume=50,
        )
        item = _option_dict(ticker)
        self.assertEqual(item["gamma"], 0.02345679)
        self.assertEqual(item["open_interest"], 321.0)


if __name__ == "__main__":
    unittest.main()
