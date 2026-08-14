from AlgorithmImports import *

from collections import deque
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import time
from urllib import request

from signal_engine import build_signal, calculate_indicators, market_data_readiness
from shadow_support import LANES, lane_strategy_families, normalize_lane, read_json, selected_expiry, signed_headers, zerogex_primary


class LeanShadowAlgorithm(QCAlgorithm):
    """IBKR read-only LEAN signal publisher; every order method is forbidden."""

    def initialize(self):
        self.set_time_zone(TimeZones.NEW_YORK)
        self.set_start_date(2026, 1, 1)
        self.set_cash(100000)
        self.spy = self.add_equity("SPY", Resolution.MINUTE).symbol
        self.qqq = self.add_equity("QQQ", Resolution.MINUTE).symbol
        self.option = self.add_option("SPY", Resolution.MINUTE).symbol
        self.option.set_filter(lambda universe: universe.include_weeklys().strikes(-6, 6).expiration(0, 7))
        self._bars = {self.spy: deque(maxlen=180), self.qqq: deque(maxlen=180)}
        self._latest_chain = []
        self._previous = {}
        self._sequence = 0
        self._order_guard = "ARMED"
        self._last_error = None
        self._state_file = Path(os.getenv("LEAN_SHADOW_STATE_FILE", "/state/health.json"))
        self._policy_file = os.getenv("LEAN_SHADOW_POLICY_FILE", "/strategy-data/trade/policy.json")
        self._zerogex_file = os.getenv("LEAN_ZEROGEX_FILE", "/strategy-data/trade/zerogex.json")
        self._endpoint = os.getenv("LEAN_SHADOW_BACKEND_URL", "")
        self._secret = os.getenv("LEAN_SHADOW_INGEST_SECRET", "")
        self._run_id = os.getenv("LEAN_SHADOW_RUN_ID", "lean-shadow-v1")
        self._revision = os.getenv("LEAN_SHADOW_REVISION", "unconfigured")
        self.schedule.on(self.date_rules.every_day(self.spy), self.time_rules.every(timedelta(seconds=30)), self.publish_snapshot)
        self.set_warm_up(120, Resolution.MINUTE)

    def on_data(self, data):
        for symbol in (self.spy, self.qqq):
            if symbol in data.bars:
                bar = data.bars[symbol]
                self._bars[symbol].append({"time": float(bar.end_time.timestamp()), "open": float(bar.open), "high": float(bar.high), "low": float(bar.low), "close": float(bar.close), "volume": float(bar.volume)})
        chain = data.option_chains.get(self.option)
        if chain is not None:
            self._latest_chain = list(chain)

    # Guard common lowercase and QC PascalCase order APIs. The shared IBKR
    # Gateway must also be configured read-only, making this defence in depth.
    def _deny_order(self, *_args, **_kwargs):
        self._order_guard = "VIOLATED"
        self._last_error = "LEAN order API was invoked; no order was sent"
        self.publish_snapshot()
        raise RuntimeError(self._last_error)

    market_order = _deny_order
    limit_order = _deny_order
    stop_market_order = _deny_order
    stop_limit_order = _deny_order
    set_holdings = _deny_order
    liquidate = _deny_order
    MarketOrder = _deny_order
    LimitOrder = _deny_order
    StopMarketOrder = _deny_order
    StopLimitOrder = _deny_order
    SetHoldings = _deny_order
    Liquidate = _deny_order

    def _contract(self, contract, now):
        bid, ask = float(contract.bid_price or 0), float(contract.ask_price or 0)
        mid = (bid + ask) / 2 if bid > 0 and ask >= bid else None
        greeks = contract.greeks
        return {
            "local_symbol": str(contract.symbol), "right": str(contract.right)[0:1],
            "strike": float(contract.strike), "expiry": contract.expiry.strftime("%Y%m%d"),
            "bid": bid or None, "ask": ask or None, "mid": round(mid, 3) if mid else None,
            "spread_pct": round((ask - bid) / mid * 100, 1) if mid else None,
            "delta": float(greeks.delta) if greeks and greeks.delta is not None else None,
            "gamma": float(greeks.gamma) if greeks and greeks.gamma is not None else None,
            "open_interest": None, "volume": float(contract.volume or 0),
            "liquidity": "ok" if mid and (ask - bid) / mid * 100 <= 10 else "wide" if mid else "noquote",
            "quote_time": now, "quote_age_seconds": 0,
        }

    def publish_snapshot(self):
        now = time.time()
        health = {"connected": bool(self.live_mode and len(self._bars[self.spy]) >= 30 and self._latest_chain), "order_guard": self._order_guard, "last_error": self._last_error}
        try:
            signals = self._signals(now)
        except Exception as error:
            self._last_error = f"{type(error).__name__}: {error}"
            health["connected"] = False
            health["last_error"] = self._last_error
            signals = {lane: self._wait_signal(lane, now, self._last_error) for lane in LANES}
        self._sequence += 1
        envelope = {"runId": self._run_id, "revision": self._revision, "sequence": self._sequence, "generatedAt": datetime.utcnow().replace(microsecond=0).isoformat() + "Z", "signals": signals, "health": health}
        self._write_health(envelope)
        if os.getenv("LEAN_SHADOW_ENABLED") == "true" and len(self._secret) >= 32 and self._endpoint:
            body = json.dumps(envelope, separators=(",", ":")).encode()
            try:
                req = request.Request(self._endpoint, data=body, headers=signed_headers(self._secret, envelope), method="POST")
                with request.urlopen(req, timeout=5) as response:
                    if response.status >= 300:
                        raise RuntimeError(f"shadow ingest returned HTTP {response.status}")
            except Exception as error:
                self._last_error = f"publish failed: {type(error).__name__}: {error}"
                self._write_health(envelope)

    def _signals(self, now):
        policy = read_json(self._policy_file)
        bars = {"SPY": list(self._bars[self.spy]), "QQQ": list(self._bars[self.qqq])}
        symbols = {}
        indicators = {}
        for name, symbol in (("SPY", self.spy), ("QQQ", self.qqq)):
            security = self.securities[symbol]
            symbols[name] = {"spot": float(security.price or 0) or None, "bid": float(security.bid_price or 0) or None, "ask": float(security.ask_price or 0) or None, "last": float(security.price or 0) or None, "quote_time": now, "quote_age_seconds": 0, "bars": bars[name]}
            indicators[name] = calculate_indicators(bars[name])
        market = {"generated_at": now, "source": "IBKR", "data_type": "live", "transport": {"connected": True, "host": os.getenv("IBKR_HOST"), "port": os.getenv("IBKR_PORT"), "client_id": 0}, "symbols": symbols}
        market["market_data_readiness"] = market_data_readiness(market, indicators, now=now, stale_after=5)
        contracts = [self._contract(contract, now) for contract in self._latest_chain]
        expiry, expiry_mode = selected_expiry(contracts, now)
        options = {"generated_at": now, "source": "IBKR", "underlying": "SPY", "expiry": expiry, "expiry_mode": expiry_mode, "contracts": [contract for contract in contracts if contract["expiry"] == expiry]}
        gex_raw = read_json(self._zerogex_file)
        gex = zerogex_primary(gex_raw, now)
        max_debit = float(policy.get("strategy_max_total_debit_dollars", 500))
        max_contracts = int(policy.get("strategy_max_contracts", 1))
        preferred = min(max_contracts, int(policy.get("strategy_preferred_contracts", 1)))
        configured_families = policy.get("strategy_families") if isinstance(policy.get("strategy_families"), dict) else None
        signals = {}
        for lane in LANES:
            signal = build_signal(market, indicators, options, gex, 5, previous_signal=self._previous.get(lane), zerogex=gex_raw, zerogex_role="primary", zerogex_features={"structure_context": True, "flow_context": True, "session_levels": True, "late_day_forced_flow": True}, paper_exit_target=2, same_side_reentry_cooldown_seconds=900, max_tracking_gap_seconds=30, option_max_total_debit_dollars=max_debit, option_preferred_contracts=preferred, option_max_otm_steps=6, option_min_abs_delta=0.15, option_max_spread_pct=5, session_policy=policy.get("session"), trendline_structure=policy.get("trendline_structure"), strategy_families=lane_strategy_families(configured_families, lane), cross_market_confirmation="shadow")
            signals[lane] = normalize_lane(signal, lane)
        self._previous = signals
        return signals

    def _wait_signal(self, lane, now, reason):
        return {"engine_version": "signal-only-v2", "execution_enabled": False, "strategy_lane": lane, "generated_at": now, "state": "WAIT", "signal_phase": "NO_TRADE", "favoring": "no-trade", "strategy": "LEAN_SHADOW", "call_setup": {}, "put_setup": {}, "blockers": [reason], "lifecycle": {"status": "WAIT", "entry_allowed": False, "paper_position_open": False}}

    def _write_health(self, envelope):
        self._state_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._state_file.with_suffix(".tmp")
        temporary.write_text(json.dumps({"updated_at": time.time(), **envelope["health"]}, separators=(",", ":")))
        temporary.replace(self._state_file)
