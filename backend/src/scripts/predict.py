#!/usr/bin/env python3
import sys
import json
import os

def fallback_probability(features):
    """
    Fallback mathematical logistic regression model based on standard options scoring.
    Ensures the script always yields a valid probability even if no trained joblib exists.
    """
    score = float(features.get("signal_score", 70))
    vix = float(features.get("vix_price", 15))
    signal_type = str(features.get("signal_type", "CALL")).upper()
    rsi5 = float(features.get("rsi5", 50))
    flow_dir = float(features.get("flow_direction", 0)) # -1 (bearish), 0 (neutral), 1 (bullish)
    trend = float(features.get("trend_aligned", 1))
    internals = float(features.get("internals_aligned", 1))
    
    # Standard logistic regression formula: z = beta_0 + sum(beta_i * x_i)
    # We calibrate these coefficients to match general trading heuristics:
    z = -1.5 # base bias
    
    # Setup score (higher technical score is better)
    z += 0.035 * (score - 60)
    
    # VIX alignment: high VIX makes calls riskier, puts more favorable
    if signal_type == "CALL":
        z -= 0.04 * (vix - 15)
    else:
        z += 0.02 * (vix - 15)
        
    # Flow direction alignment
    z += 0.5 * flow_dir
    
    # Trend and mega-cap internals alignment
    z += 0.4 * trend
    z += 0.3 * internals
    
    # RSI check: calling bottom (mean reversion) or buying breakout
    if signal_type == "CALL" and rsi5 < 30: # oversold mean reversion call
        z += 0.25
    elif signal_type == "PUT" and rsi5 > 70: # overbought mean reversion put
        z += 0.25
        
    # Logistic function: P = 1 / (1 + exp(-z))
    import math
    try:
        prob = 1.0 / (1.0 + math.exp(-z))
    except OverflowError:
        prob = 0.0 if z < 0 else 1.0
        
    return prob

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No input features JSON string provided."}))
        sys.exit(1)
        
    try:
        features = json.loads(sys.argv[1])
    except Exception as e:
        print(json.dumps({"error": f"Failed to parse input JSON: {str(e)}"}))
        sys.exit(1)
        
    script_dir = os.path.dirname(os.path.realpath(__file__))
    model_path = os.path.join(script_dir, "options_model.joblib")
    
    # Attempt to load trained scikit-learn model if available
    if os.path.exists(model_path):
        try:
            import joblib
            model = joblib.load(model_path)
            
            # Feature ordering must match train.py exactly
            feature_cols = [
                "signal_score", "vix_price", "rsi5", "rsi14", "vwap_dist_pct",
                "flow_direction", "trend_aligned", "internals_aligned"
            ]
            
            x = [[float(features.get(col, 0)) for col in feature_cols]]
            # Predict probability of class 1 (Setup Success)
            prob = float(model.predict_proba(x)[0][1])
            print(json.dumps({"probability": prob, "source": "ml_model"}))
            return
        except Exception as e:
            # Fallback on import or loading failure
            pass
            
    # Fallback to math model
    prob = fallback_probability(features)
    print(json.dumps({"probability": prob, "source": "fallback_math"}))

if __name__ == "__main__":
    main()
