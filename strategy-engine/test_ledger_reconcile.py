#!/usr/bin/env python3
"""Tests for reconcile_open_positions — the fix for phantom managed positions.

The engine assumes a fill at activation; this reconciliation folds the backend
ledger truth back in. The safety-critical property: it must NEVER demote a lane
that holds a real or in-flight position (that would strip invalidation
protection); it only demotes lanes the backend is CONFIDENT hold no position.
"""

import unittest

from signal_engine import reconcile_open_positions


def _managed_lane(state="MANAGE"):
    return {
        "state": state,
        "favoring": "puts",
        "strategy": "MTF_TREND_BREAK",
        "lifecycle": {"status": state, "entry_allowed": False, "paper_position_open": True},
    }


class ReconcileOpenPositionsTest(unittest.TestCase):
    def test_confident_no_position_demotes_lane(self):
        # Backend confident the mtf lane holds NO open position -> phantom -> demote.
        lanes = {"mtf": _managed_lane("MANAGE")}
        recon = {"lanes": {"mtf": {"open": False, "confident": True}}}
        out = reconcile_open_positions(lanes, recon)
        self.assertEqual(out["mtf"]["state"], "WAIT")
        self.assertFalse(out["mtf"]["lifecycle"]["paper_position_open"])
        self.assertTrue(out["mtf"]["reconciled_no_position"])

    def test_open_position_is_left_untouched(self):
        # A confirmed open position must keep managing — never demoted.
        lanes = {"mtf": _managed_lane("MANAGE")}
        recon = {"lanes": {"mtf": {"open": True, "confident": True}}}
        out = reconcile_open_positions(lanes, recon)
        self.assertEqual(out["mtf"]["state"], "MANAGE")
        self.assertTrue(out["mtf"]["lifecycle"]["paper_position_open"])

    def test_in_flight_entry_is_left_untouched(self):
        # Not-yet-confident (a fill may be in flight) -> do NOT demote, or we'd
        # strip protection off a position that is about to exist.
        lanes = {"mtf": _managed_lane("ACTIVE")}
        recon = {"lanes": {"mtf": {"open": False, "confident": False}}}
        out = reconcile_open_positions(lanes, recon)
        self.assertEqual(out["mtf"]["state"], "ACTIVE")
        self.assertTrue(out["mtf"]["lifecycle"]["paper_position_open"])

    def test_no_reconciliation_is_noop(self):
        lanes = {"mtf": _managed_lane("MANAGE")}
        self.assertEqual(reconcile_open_positions(lanes, None)["mtf"]["state"], "MANAGE")
        self.assertEqual(reconcile_open_positions(lanes, {})["mtf"]["state"], "MANAGE")

    def test_lane_absent_from_reconciliation_is_untouched(self):
        lanes = {"mtf": _managed_lane("MANAGE"), "orb_index": _managed_lane("ACTIVE")}
        recon = {"lanes": {"mtf": {"open": False, "confident": True}}}
        out = reconcile_open_positions(lanes, recon)
        self.assertEqual(out["mtf"]["state"], "WAIT")           # reconciled
        self.assertEqual(out["orb_index"]["state"], "ACTIVE")   # not mentioned -> untouched

    def test_does_not_mutate_input(self):
        lanes = {"mtf": _managed_lane("MANAGE")}
        reconcile_open_positions(lanes, {"lanes": {"mtf": {"open": False, "confident": True}}})
        self.assertEqual(lanes["mtf"]["state"], "MANAGE")       # original untouched
        self.assertTrue(lanes["mtf"]["lifecycle"]["paper_position_open"])

    def test_malformed_inputs_do_not_crash(self):
        self.assertEqual(reconcile_open_positions(None, None), {})
        self.assertEqual(reconcile_open_positions({"mtf": None}, {"lanes": {"mtf": {"open": False, "confident": True}}}),
                         {"mtf": None})
        self.assertEqual(reconcile_open_positions({"mtf": _managed_lane()}, {"lanes": "bad"})["mtf"]["state"], "MANAGE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
