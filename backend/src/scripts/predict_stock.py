
import sys
import json
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier

def calculate_rsi(data, window=14):
    delta = data.diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=window).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=window).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))

def calculate_ema(data, window):
    return data.ewm(span=window, adjust=False).mean()

def process_and_predict():
    try:
        # Read JSON from stdin
        input_data = sys.stdin.read()
        if not input_data:
            raise ValueError("No input data received")
            
        json_data = json.loads(input_data)
        
        # Convert to DataFrame
        df = pd.DataFrame(json_data)
        df['date'] = pd.to_datetime(df['date'])
        df = df.sort_values('date')
        df.set_index('date', inplace=True)
        
        # Feature Engineering
        df['Close_Shift_1'] = df['close'].shift(1)
        df['Open_Shift_1'] = df['open'].shift(1)
        
        # EMA Indicators
        df['EMA9'] = calculate_ema(df['close'], 9)
        df['EMA21'] = calculate_ema(df['close'], 21)
        
        # Target: 1 if Price went UP next day
        df['Target'] = (df['close'].shift(-1) > df['close']).astype(int)
        
        # Rolling Averages / Windows
        horizons = [2, 5, 10, 60, 250]
        predictors = ['EMA9', 'EMA21']
        
        for horizon in horizons:
            rolling_averages = df.rolling(horizon).mean()
            
            ratio_column = f"Close_Ratio_{horizon}"
            df[ratio_column] = df['close'] / rolling_averages['close']
            
            trend_column = f"Trend_{horizon}"
            df[trend_column] = df.shift(1).rolling(horizon).sum()['Target']
            
            predictors += [ratio_column, trend_column]

        # Additional Indicators
        df['RSI'] = calculate_rsi(df['close'])
        predictors.append('RSI')

        # Drop NaNs created by rolling/shifting
        df_clean = df.dropna()

        if len(df_clean) < 50:
             # Not enough data for robust ML training on this specific history
             raise ValueError("Insufficient data points after preprocessing for ML")

        # Split Train/Test (Last 100 days as 'test' simulation, rest as train)
        # Or standard split. Given users want "Calculated/Simulated" data...
        # We will train on ALL available data except the very last row (which is today/latest)
        # Then predict for the "Next Day".

        model = RandomForestClassifier(n_estimators=100, min_samples_split=100, random_state=1)
        
        # Training
        train = df_clean.iloc[:-1] # All except last
        test = df_clean.iloc[-1:]  # Last row (Current state to predict Next)
        
        model.fit(train[predictors], train['Target'])
        
        # Prediction
        preds = model.predict_proba(test[predictors])[:, 1] # Probability of UP
        preds_binary = (preds >= 0.6).astype(int) # High threshold for "Buy"
        
        # Calculate recent accuracy (Backtest on last 60 days) to give "User Understanding"
        # validation_set = df_clean.iloc[-60:]
        # val_preds = model.predict(validation_set[predictors])
        # accuracy = (val_preds == validation_set['Target']).mean()
        
        # Simply return the prediction and probabilities
        probability_up = float(preds[0])
        sentiment = "Bullish" if probability_up > 0.55 else "Bearish" if probability_up < 0.45 else "Neutral"
        
        result = {
            "prediction_probability_up": probability_up,
            "sentiment": sentiment,
            "features": {
                "rsi": float(test['RSI'].iloc[0]) if not pd.isna(test['RSI'].iloc[0]) else 0,
                "close_ratio_5": float(test['Close_Ratio_5'].iloc[0]),
                "trend_5": float(test['Trend_5'].iloc[0])
            }
        }
        
        print(json.dumps(result))

    except Exception as e:
        error_response = {
            "error": str(e)
        }
        print(json.dumps(error_response))
        sys.exit(1)

if __name__ == "__main__":
    process_and_predict()
