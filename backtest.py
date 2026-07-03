import sys
import time
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
    print("🔄 Connecting to Interactive Brokers Gateway ('ib_gateway':4004)...")
    ib = IB()
    try:
        ib.connect('ib_gateway', 4004, clientId=10)
    except Exception as e:
        print(f"❌ Connection failed: {e}")
        sys.exit(1)
        
    tickers = ["SPY", "QQQ", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"]
    
    # We audit May 2026 (fetch starts from April 20 to have 20 daily bars for EMAs and Runway)
    end_time_str = "20260601 16:00:00 EST"
    
    all_trades_3m = []
    all_trades_5m = []
    
    print("\n🔄 Fetching 1-minute historical bars from IBKR (with rate-limit spacing)...")
    
    for ticker in tickers:
        print(f"  Fetching {ticker}...")
        contract = Stock(ticker, 'SMART', 'USD')
        ib.qualifyContracts(contract)
        
        # 1. Fetch historical 1-minute bars (covering roughly 30 days)
        bars_1m = ib.reqHistoricalData(
            contract,
            endDateTime=end_time_str,
            durationStr='35 D',
            barSizeSetting='1 min',
            whatToShow='TRADES',
            useRTH=True,
            keepUpToDate=False
        )
        
        # Sleep to comply with IB pacing rules
        time.sleep(2)
        
        if not bars_1m:
            print(f"    ⚠️ No 1-minute data returned for {ticker}")
            continue
            
        # 2. Fetch daily bars to calculate the EMAs and 20-day high for runway checks
        bars_daily = ib.reqHistoricalData(
            contract,
            endDateTime=end_time_str,
            durationStr='60 D',
            barSizeSetting='1 day',
            whatToShow='TRADES',
            useRTH=True,
            keepUpToDate=False
        )
        
        # Sleep to comply with IB pacing rules
        time.sleep(2)
        
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
            # Convert timezone if needed (TWS returns exchange/local time or datetime)
            date_str = dt.strftime("%Y-%m-%d")
            time_str = dt.strftime("%H:%M")
            if date_str not in day_groups:
                day_groups[date_str] = []
            day_groups[date_str].append({"time": time_str, "o": b.open, "c": b.close, "h": b.high, "l": b.low})
            
        sorted_days = sorted(day_groups.keys())
        may_days = [d for d in sorted_days if d.startswith("2026-05")]
        
        # Calculate MOC opens (15:55-16:00 open of the 5-min block)
        moc_map = {}
        for d in sorted_days:
            day_bars = day_groups[d]
            # MOC open is the open of the 15:55 bar
            moc_bar = next((b for b in day_bars if b["time"] == "15:55"), None)
            if moc_bar:
                moc_map[d] = moc_bar["o"]
                
        # Audit each day in May
        for d in may_days:
            try:
                curr_idx = sorted_days.index(d)
                if curr_idx == 0:
                    continue
                prev_date = sorted_days[curr_idx - 1]
            except ValueError:
                continue
                
            # Find previous day close and MOC open
            # Prior daily bars
            daily_idx = next((i for i, db in enumerate(daily_list) if db["date"] == prev_date), None)
            if daily_idx is None:
                continue
                
            prev_close = daily_list[daily_idx]["c"]
            prev_moc_o = moc_map.get(prev_date)
            
            if not prev_close or not prev_moc_o:
                continue
                
            # Check previous day MOC Bullish condition
            prev_day_bull = prev_close > prev_moc_o
            if not prev_day_bull:
                continue
                
            # Check Runway Status using daily list
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
            
            # --- 3-MINUTE EVALUATION ---
            open_bars_3m = [b for b in day_bars if "09:30" <= b["time"] <= "09:32"]
            if len(open_bars_3m) >= 3:
                open_bars_3m = sorted(open_bars_3m, key=lambda x: x["time"])
                o_bar = open_bars_3m[0]["o"]
                c_bar = open_bars_3m[-1]["c"]
                l_bar = min(b["l"] for b in open_bars_3m)
                
                if c_bar > o_bar:
                    flush_pct = (o_bar - l_bar) / o_bar * 100
                    if flush_pct <= 0.25:
                        grade = "A+" if flush_pct <= 0.10 else "A"
                        exit_bars = [b for b in day_bars if "09:30" <= b["time"] <= "10:30"]
                        max_run = max(b["h"] for b in exit_bars) if exit_bars else c_bar
                        run_gain = (max_run - c_bar) / c_bar * 100
                        all_trades_3m.append({
                            "date": d, "ticker": ticker, "prev_close": prev_close, "c": c_bar,
                            "flush": flush_pct, "grade": grade, "runway": status, "max_run": max_run, "run_pct": run_gain
                        })
                        
            # --- 5-MINUTE EVALUATION ---
            open_bars_5m = [b for b in day_bars if "09:30" <= b["time"] <= "09:34"]
            if len(open_bars_5m) >= 5:
                open_bars_5m = sorted(open_bars_5m, key=lambda x: x["time"])
                o_bar = open_bars_5m[0]["o"]
                c_bar = open_bars_5m[-1]["c"]
                l_bar = min(b["l"] for b in open_bars_5m)
                
                if c_bar > o_bar:
                    flush_pct = (o_bar - l_bar) / o_bar * 100
                    if flush_pct <= 0.25:
                        grade = "A+" if flush_pct <= 0.10 else "A"
                        exit_bars = [b for b in day_bars if "09:30" <= b["time"] <= "10:30"]
                        max_run = max(b["h"] for b in exit_bars) if exit_bars else c_bar
                        run_gain = (max_run - c_bar) / c_bar * 100
                        all_trades_5m.append({
                            "date": d, "ticker": ticker, "prev_close": prev_close, "c": c_bar,
                            "flush": flush_pct, "grade": grade, "runway": status, "max_run": max_run, "run_pct": run_gain
                        })

    ib.disconnect()
    
    # Sort and display results
    all_trades_3m = sorted(all_trades_3m, key=lambda x: (x["date"], x["ticker"]))
    all_trades_5m = sorted(all_trades_5m, key=lambda x: (x["date"], x["ticker"]))
    
    print("\n=========================================================================================================")
    print("📋 IBKR AUDITED GOLDEN CHAIN SIGNALS (3-MINUTE TIMEFRAME) - MAY 2026")
    print("=========================================================================================================")
    print(f"{'Date':<12} | {'Ticker':<6} | {'Prev Close':<10} | {'Entry (9:33)':<12} | {'Flush %':<8} | {'Grade':<5} | {'Runway':<8} | {'Max High to 10:30':<18}")
    print("-" * 110)
    for t in all_trades_3m:
        print(f"{t['date']:<12} | {t['ticker']:<6} | {t['prev_close']:<10.2f} | {t['c']:<12.2f} | {t['flush']:<8.3f}% | {t['grade']:<5} | {t['runway']:<8} | {t['max_run']:<6.2f} (+{t['run_pct']:.2f}%)")

    print("\n=========================================================================================================")
    print("📋 IBKR AUDITED GOLDEN CHAIN SIGNALS (5-MINUTE TIMEFRAME) - MAY 2026")
    print("=========================================================================================================")
    print(f"{'Date':<12} | {'Ticker':<6} | {'Prev Close':<10} | {'Entry (9:35)':<12} | {'Flush %':<8} | {'Grade':<5} | {'Runway':<8} | {'Max High to 10:30':<18}")
    print("-" * 110)
    for t in all_trades_5m:
        print(f"{t['date']:<12} | {t['ticker']:<6} | {t['prev_close']:<10.2f} | {t['c']:<12.2f} | {t['flush']:<8.3f}% | {t['grade']:<5} | {t['runway']:<8} | {t['max_run']:<6.2f} (+{t['run_pct']:.2f}%)")

if __name__ == "__main__":
    main()
