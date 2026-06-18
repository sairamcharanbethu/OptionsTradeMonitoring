#!/usr/bin/env python3
import sys
import os
import json
from datetime import datetime, timezone
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    import joblib
    HAS_DEPENDENCIES = True
except ImportError as e:
    HAS_DEPENDENCIES = False
    DEP_ERROR = str(e)

def get_db_connection():
    """
    Get postgres connection using DATABASE_URL or defaults.
    """
    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        return psycopg2.connect(db_url, cursor_factory=RealDictCursor)
        
    # Standard local defaults
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "localhost"),
        database=os.environ.get("PGDATABASE", "options_trading"),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "postgres"),
        port=os.environ.get("PGPORT", "5432"),
        cursor_factory=RealDictCursor
    )

def parse_time(value):
    if value is None:
        return None

    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    if isinstance(value, (int, float)):
        timestamp = value / 1000 if value > 100000000000 else value
        return datetime.fromtimestamp(timestamp, tz=timezone.utc)

    if isinstance(value, str):
        try:
            normalized = value.replace("Z", "+00:00")
            parsed = datetime.fromisoformat(normalized)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            return None

    return None

def parse_price(bar):
    if not isinstance(bar, dict):
        return None

    for key in ("price", "close", "adjclose", "adjClose", "regularMarketPrice"):
        value = bar.get(key)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue

    return None

def extract_history_bars(data):
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except json.JSONDecodeError:
            return []

    if isinstance(data, list):
        return data

    if not isinstance(data, dict):
        return []

    for key in ("quotes", "data", "prices", "history", "bars"):
        value = data.get(key)
        if isinstance(value, list):
            return value

    result = (((data.get("chart") or {}).get("result") or [None])[0] or {})
    timestamps = result.get("timestamp") or []
    quote = ((((result.get("indicators") or {}).get("quote") or [None])[0]) or {})
    closes = quote.get("close") or []
    if timestamps and closes:
        return [{"timestamp": ts, "close": close} for ts, close in zip(timestamps, closes)]

    return []

def normalize_history_candles(data, created_at):
    created_time = parse_time(created_at)
    candles = []

    for bar in extract_history_bars(data):
        if not isinstance(bar, dict):
            continue

        bar_time = None
        for key in ("timestamp", "date", "datetime", "time", "regularMarketTime"):
            bar_time = parse_time(bar.get(key))
            if bar_time:
                break

        price = parse_price(bar)
        if price is None:
            continue

        if created_time and bar_time and bar_time <= created_time:
            continue

        candles.append({"timestamp": bar_time or datetime.max.replace(tzinfo=timezone.utc), "price": price})

    candles.sort(key=lambda candle: candle["timestamp"])
    return candles[:100]

def simulate_outcome(conn, signal):
    """
    Simulates signal success by tracking subsequent 5-minute candles in cache.
    Success (1) = Spot hits target_price before stop_loss.
    Failure (0) = Spot hits stop_loss first, or doesn't trigger.
    """
    symbol = signal["symbol"]
    created_at = signal["created_at"]
    entry = float(signal["entry_trigger"]) if signal["entry_trigger"] else None
    sl = float(signal["stop_loss"]) if signal["stop_loss"] else None
    tp = float(signal["target_price"]) if signal["target_price"] else None
    bias = signal["trade_bias"]
    
    if not entry or not sl or not tp:
        return None
        
    with conn.cursor() as cur:
        cur.execute("""
            SELECT data FROM stock_history_cache
            WHERE symbol = %s
            LIMIT 1
        """, (symbol,))
        history = cur.fetchone()

    candles = normalize_history_candles(history["data"], created_at) if history else []
        
    if not candles:
        return None
        
    triggered = False
    for c in candles:
        price = c["price"]
        
        # Check if trade gets triggered
        if not triggered:
            if bias.startswith("BUY_CALL") and price >= entry:
                triggered = True
            elif bias.startswith("BUY_PUT") and price <= entry:
                triggered = True
            else:
                continue
                
        # Once triggered, track if TP or SL is hit first
        if bias.startswith("BUY_CALL"):
            if price >= tp:
                return 1
            if price <= sl:
                return 0
        else: # PUT setup
            if price <= tp:
                return 1
            if price >= sl:
                return 0
                
    return 0 # Never triggered or expired out

def main():
    if not HAS_DEPENDENCIES:
        print(json.dumps({"error": f"Missing python dependencies: {DEP_ERROR}. Model training aborted."}))
        sys.exit(0)
        
    try:
        conn = get_db_connection()
    except Exception as e:
        print(json.dumps({"error": f"Failed to connect to database: {str(e)}"}))
        sys.exit(1)
        
    try:
        # Load past enriched signals
        with conn.cursor() as cur:
            cur.execute("""
                SELECT 
                  id, symbol, signal_type, trade_bias, 
                  current_price::double precision, entry_trigger::double precision, 
                  stop_loss::double precision, target_price::double precision, 
                  confidence_score, indicators, gex, volatility, created_at
                FROM signals
                WHERE signal_type != 'NONE'
                ORDER BY created_at DESC
                LIMIT 500
            """)
            signals = cur.fetchall()
            
        if len(signals) < 10:
            print(json.dumps({"status": "skipped", "message": "Need at least 10 signals to train ML model."}))
            return
            
        features = []
        labels = []
        
        for sig in signals:
            outcome = simulate_outcome(conn, sig)
            if outcome is None:
                continue
                
            ind = sig["indicators"] or {}
            gex = sig["gex"] or {}
            vol = sig["volatility"] or {}
            
            # Feature extraction
            rsi5 = float(ind.get("rsi5", 50))
            rsi14 = float(ind.get("rsi14", 50))
            vwap = float(ind.get("vwap", sig["current_price"]))
            vwap_dist = ((sig["current_price"] - vwap) / vwap) * 100
            
            flow_str = str(gex.get("flowDirection", "neutral")).lower()
            flow_dir = 1.0 if flow_str == "bullish" else (-1.0 if flow_str == "bearish" else 0.0)
            
            ema9 = float(ind.get("emaShort") or 0)
            ema21 = float(ind.get("emaLong") or 0)
            trend_aligned = 1.0 if (sig["signal_type"] == "CALL" and ema9 > ema21) or (sig["signal_type"] == "PUT" and ema9 < ema21) else 0.0
            
            internals_bullish = bool(ind.get("internalsBullish", False))
            internals_bearish = bool(ind.get("internalsBearish", False))
            internals_aligned = 1.0 if (sig["signal_type"] == "CALL" and internals_bullish) or (sig["signal_type"] == "PUT" and internals_bearish) else 0.0
            
            vix_val = vol.get("vixQuote")
            if vix_val is None:
                vix_val = vol.get("price", 15)

            feat_vector = [
                float(sig["confidence_score"]),
                float(vix_val),
                rsi5,
                rsi14,
                vwap_dist,
                flow_dir,
                trend_aligned,
                internals_aligned
            ]
            
            features.append(feat_vector)
            labels.append(outcome)
            
        if len(features) < 10:
            print(json.dumps({"status": "skipped", "message": "Insufficient valid historical outcomes."}))
            return
            
        X = np.array(features)
        y = np.array(labels)
        
        # Train simple robust LogisticRegression
        model = LogisticRegression(C=1.0, max_iter=200)
        model.fit(X, y)
        
        script_dir = os.path.dirname(os.path.realpath(__file__))
        model_path = os.path.join(script_dir, "options_model.joblib")
        joblib.dump(model, model_path)
        
        print(json.dumps({
            "status": "success",
            "message": f"Successfully trained model on {len(features)} signal examples.",
            "accuracy": float(model.score(X, y))
        }))
        
    except Exception as e:
        print(json.dumps({"error": f"Training failed: {str(e)}"}))
    finally:
        conn.close()

if __name__ == "__main__":
    main()
