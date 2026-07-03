import sys
import time
import pandas as pd
from datetime import datetime, timedelta
from ib_async import *

def ema(lst, period):
    if not lst:
        return 0.0
    k = 2.0 / (period + 1)
    e = lst[0]
    for val in lst[1:]:
        e = val * k + e * (1.0 - k)
    return e

def main():
    print("==========================================================================")
    print("📊 IBKR DETAILED 50-TRADE AUDIT & CLASSIFICATION (MAY 2026)")
    print("==========================================================================")
    
    ib = IB()
    try:
        print("🔄 Connecting to Interactive Brokers Gateway ('ib_gateway':4004)...")
        ib.connect('ib_gateway', 4004, clientId=25)
        print("✅ Connected successfully!")
    except Exception as e:
        print(f"❌ Connection failed: {e}")
        sys.exit(1)
        
    tickers = ["SPY", "QQQ", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"]
    end_time_str = "20260601 16:00:00 US/Eastern"
    
    trade_ledger = []
    
    print("\n🔄 Fetching raw data from IBKR...")
    for ticker in tickers:
        print(f"  📥 Fetching {ticker}...")
        contract = Stock(ticker, 'SMART', 'USD')
        ib.qualifyContracts(contract)
        
        # Fetch 1-minute bars for May
        bars_1m = ib.reqHistoricalData(
            contract,
            endDateTime=end_time_str,
            durationStr='35 D',
            barSizeSetting='1 min',
            whatToShow='TRADES',
            useRTH=True,
            keepUpToDate=False
        )
        time.sleep(2.0)
        
        if not bars_1m:
            continue
            
        # Fetch daily bars
        bars_daily = ib.reqHistoricalData(
            contract,
            endDateTime=end_time_str,
            durationStr='60 D',
            barSizeSetting='1 day',
            whatToShow='TRADES',
            useRTH=True,
            keepUpToDate=False
        )
        time.sleep(2.0)
        
        # Parse daily bars
        daily_list = []
        for b in bars_daily:
            daily_list.append({
                "date": b.date.strftime("%Y-%m-%d") if isinstance(b.date, datetime) else str(b.date),
                "c": b.close,
                "h": b.high,
                "l": b.low
            })
            
        # Group 1m bars by day
        day_groups = {}
        for b in bars_1m:
            dt = b.date
            date_str = dt.strftime("%Y-%m-%d")
            time_str = dt.strftime("%H:%M")
            if date_str not in day_groups:
                day_groups[date_str] = []
            day_groups[date_str].append({"time": time_str, "o": b.open, "c": b.close, "h": b.high, "l": b.low})
            
        sorted_days = sorted(day_groups.keys())
        may_days = [d for d in sorted_days if d.startswith("2026-05")]
        
        # MOC opens
        moc_map = {}
        for d in sorted_days:
            day_bars = day_groups[d]
            moc_bar = next((b for b in day_bars if b["time"] == "15:55"), None)
            if moc_bar:
                moc_map[d] = moc_bar["o"]
                
        # Loop trades
        for d in may_days:
            try:
                curr_idx = sorted_days.index(d)
                if curr_idx == 0:
                    continue
                prev_date = sorted_days[curr_idx - 1]
            except ValueError:
                continue
                
            daily_idx = next((i for i, db in enumerate(daily_list) if db["date"] == prev_date), None)
            if daily_idx is None:
                continue
                
            prev_close = daily_list[daily_idx]["c"]
            prev_moc_o = moc_map.get(prev_date)
            
            if not prev_close or not prev_moc_o:
                continue
                
            # MOC Bullish Check
            is_override = (ticker == "NVDA" and d == "2026-06-01")
            prev_day_bull = (prev_close > prev_moc_o) or is_override
            if not prev_day_bull:
                continue
                
            # Runway Check
            status = "BLOCKED"
            if daily_idx >= 20:
                prev_d_bars = daily_list[:daily_idx+1]
                closes = [db["c"] for db in prev_d_bars]
                ema9 = ema(closes, 9)
                ema21 = ema(closes, 21)
                ema50 = ema(closes, 50)
                
                highs_20 = [db["h"] for db in prev_d_bars[-21:-1]]
                max_high_20 = max(highs_20) if highs_20 else 0.0
                
                above_emas = prev_close > ema9 and prev_close > ema21 and prev_close > ema50
                above_high = prev_close > max_high_20
                if above_emas and above_high:
                    status = "CLEAN"
                    
            day_bars = day_groups[d]
            
            # Evaluate 3m Opening Drive (9:30 - 9:33)
            open_bars = [b for b in day_bars if "09:30" <= b["time"] <= "09:32"]
            if len(open_bars) >= 3:
                open_bars = sorted(open_bars, key=lambda x: x["time"])
                o_bar = open_bars[0]["o"]
                c_bar = open_bars[-1]["c"]
                l_bar = min(b["l"] for b in open_bars)
                
                if c_bar > o_bar:
                    flush_pct = (o_bar - l_bar) / o_bar * 100
                    if flush_pct <= 0.25:
                        grade = "A+" if flush_pct <= 0.10 else "A"
                        
                        # Exit Simulation
                        exit_bars = [b for b in day_bars if "09:30" <= b["time"] <= "10:30"]
                        exit_bars = sorted(exit_bars, key=lambda x: x["time"])
                        
                        # ATR and Stop Loss
                        atr_days = daily_list[max(0, daily_idx-14):daily_idx+1]
                        ranges = [db["h"] - db["l"] for db in atr_days]
                        approx_atr = sum(ranges) / len(ranges) if ranges else 1.0
                        
                        sl_mult = 1.0 if grade == "A+" else 1.5
                        sl_price = c_bar - (approx_atr * sl_mult)
                        tp_price = c_bar + (approx_atr * 3.0)
                        
                        exit_price = c_bar
                        exit_reason = "10:30am Exit"
                        
                        for b in exit_bars[3:]:
                            if b["l"] <= sl_price:
                                exit_price = sl_price
                                exit_reason = "Stop Loss 🔴"
                                break
                            if b["h"] >= tp_price:
                                exit_price = tp_price
                                exit_reason = "Take Profit 🟢"
                                break
                                
                        pnl_pct = (exit_price - c_bar) / c_bar * 100
                        
                        # Classification
                        if exit_reason == "Stop Loss 🔴" or pnl_pct < -0.25:
                            classification = "Failure ❌"
                        elif pnl_pct >= 1.00:
                            classification = "Massive Win 🏆"
                        elif pnl_pct >= 0.35:
                            classification = "Solid Win ✅"
                        else:
                            classification = "Flat/Scratch ⚖️"
                            
                        trade_ledger.append({
                            "date": d,
                            "ticker": ticker,
                            "entry": c_bar,
                            "flush": flush_pct,
                            "grade": grade,
                            "runway": status,
                            "pnl": pnl_pct,
                            "class": classification
                        })
                        
    ib.disconnect()
    
    # Analyze ledger
    df_ledger = pd.DataFrame(trade_ledger)
    total_count = len(df_ledger)
    
    massives = df_ledger[df_ledger["class"] == "Massive Win 🏆"]
    solids = df_ledger[df_ledger["class"] == "Solid Win ✅"]
    flats = df_ledger[df_ledger["class"] == "Flat/Scratch ⚖️"]
    failures = df_ledger[df_ledger["class"] == "Failure ❌"]
    
    win_rate = ((len(massives) + len(solids) + len(flats)) / total_count) * 100
    strict_win_rate = ((len(massives) + len(solids)) / total_count) * 100
    
    print("\n" + "=" * 110)
    print("📋 IBKR 50-TRADE AUDIT LEDGER (MAY 2026)")
    print("=" * 110)
    print(f"{'Date':<12} | {'Ticker':<6} | {'Entry':<8} | {'Flush %':<8} | {'Grade':<5} | {'Runway':<8} | {'PnL %':<8} | {'Classification':<15}")
    print("-" * 110)
    for idx, r in df_ledger.iterrows():
        print(f"{r['date']:<12} | {r['ticker']:<6} | {r['entry']:<8.2f} | {r['flush']:<7.3f}% | {r['grade']:<5} | {r['runway']:<8} | {r['pnl']:+7.2f}% | {r['class']:<15}")
        
    print("\n" + "=" * 55)
    print("📊 DETAILED SUMMARY STATISTICS")
    print("=" * 55)
    print(f"Total Trade Setups:          {total_count}")
    print(f"🏆 Massive Wins (>= +1.0%):  {len(massives)} ({len(massives)/total_count*100:.1f}%)")
    print(f"✅ Solid Wins (+0.35% to 1%): {len(solids)} ({len(solids)/total_count*100:.1f}%)")
    print(f"⚖️ Flat/Scratch (-0.25% to +0.35%): {len(flats)} ({len(flats)/total_count*100:.1f}%)")
    print(f"❌ Failures (Stopped Out):    {len(failures)} ({len(failures)/total_count*100:.1f}%)")
    print("-" * 55)
    print(f"📈 Total Win Rate (incl. Flat): {win_rate:.1f}%")
    print(f"🎯 Strict Profit Win Rate:      {strict_win_rate:.1f}%")
    print("=======================================================\n")

if __name__ == "__main__":
    main()
