
import sys
import os
import json
import pandas as pd
import numpy as np
import yfinance as yf
import pandas_ta as ta
from datetime import datetime, timedelta
from sklearn.preprocessing import MinMaxScaler
from sklearn.ensemble import RandomForestRegressor
from sklearn.multioutput import MultiOutputRegressor
import joblib
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
import tensorflow as tf
from tensorflow.keras.models import Sequential, load_model
from tensorflow.keras.layers import LSTM, Dense, Dropout

# Setup
MODELS_DIR = os.path.join(os.path.dirname(__file__), '../../models')
os.makedirs(MODELS_DIR, exist_ok=True)

def get_sentiment(ticker):
    try:
        t = yf.Ticker(ticker)
        news = t.news[:10]
        if not news:
            return 0.5 # Neutral

        analyzer = SentimentIntensityAnalyzer()
        scores = []
        for n in news:
            content = n.get('content', {})
            title = content.get('title', '')
            summary = content.get('summary', '')
            text = f"{title} {summary}"
            vs = analyzer.polarity_scores(text)
            scores.append(vs['compound'])

        if not scores:
            return 0.5

        # Map -1..1 to 0..1
        avg_score = sum(scores) / len(scores)
        normalized_score = (avg_score + 1) / 2
        return normalized_score
    except Exception as e:
        return 0.5

def prepare_data(ticker):
    # Fetch 5 years of data
    end_date = datetime.now()
    start_date = end_date - timedelta(days=5*365)
    df = yf.download(ticker, start=start_date, end=end_date, interval='1d', progress=False)

    if df.empty:
        raise ValueError(f"No data found for {ticker}")

    # Handle multi-index columns
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    # Technical Indicators
    df['RSI'] = ta.rsi(df['Close'], length=14)
    macd = ta.macd(df['Close'])
    # Find columns that look like MACD
    if macd is not None:
        df['MACD'] = macd.iloc[:, 0]
        df['MACD_Signal'] = macd.iloc[:, 2]

    df['SMA_20'] = ta.sma(df['Close'], length=20)
    df['SMA_50'] = ta.sma(df['Close'], length=50)
    df['SMA_200'] = ta.sma(df['Close'], length=200)

    bbands = ta.bbands(df['Close'], length=20, std=2)
    if bbands is not None:
        df['BBL'] = bbands.iloc[:, 0]
        df['BBM'] = bbands.iloc[:, 1]
        df['BBU'] = bbands.iloc[:, 2]

    # Clean NaN
    df.dropna(inplace=True)

    return df

def train_models(ticker, df):
    # Targets: Close t+1 and t+5
    df['Target_Next_Day'] = df['Close'].shift(-1)
    df['Target_Next_Week'] = df['Close'].shift(-5)

    features = ['Close', 'RSI', 'MACD', 'MACD_Signal', 'SMA_20', 'SMA_50', 'SMA_200', 'BBL', 'BBM', 'BBU']

    train_df = df.dropna().copy()
    if len(train_df) < 100:
        raise ValueError("Not enough data to train models")

    X = train_df[features].values
    y = train_df[['Target_Next_Day', 'Target_Next_Week']].values

    # Scaler
    scaler_X = MinMaxScaler()
    scaler_y = MinMaxScaler()
    X_scaled = scaler_X.fit_transform(X)
    y_scaled = scaler_y.fit_transform(y)

    # Random Forest
    rf = MultiOutputRegressor(RandomForestRegressor(n_estimators=50, random_state=42)) # Reduced n_estimators for speed
    rf.fit(X_scaled, y_scaled)

    # LSTM
    window_size = 60
    X_lstm = []
    y_lstm = []

    for i in range(window_size, len(X_scaled)):
        X_lstm.append(X_scaled[i-window_size:i])
        y_lstm.append(y_scaled[i])

    X_lstm, y_lstm = np.array(X_lstm), np.array(y_lstm)

    model = Sequential([
        LSTM(units=32, return_sequences=True, input_shape=(window_size, len(features))), # Reduced units for speed
        Dropout(0.2),
        LSTM(units=32),
        Dropout(0.2),
        Dense(2)
    ])

    model.compile(optimizer='adam', loss='mean_squared_error')
    model.fit(X_lstm, y_lstm, epochs=5, batch_size=32, verbose=0) # Reduced epochs for speed

    # Save models
    joblib.dump(rf, os.path.join(MODELS_DIR, f"{ticker}_rf.joblib"))
    joblib.dump(scaler_X, os.path.join(MODELS_DIR, f"{ticker}_scaler_X.joblib"))
    joblib.dump(scaler_y, os.path.join(MODELS_DIR, f"{ticker}_scaler_y.joblib"))
    model.save(os.path.join(MODELS_DIR, f"{ticker}_lstm.keras"))

    return rf, model, scaler_X, scaler_y

def predict(ticker):
    ticker = ticker.upper()
    df = prepare_data(ticker)

    # Expected Move (30 day std dev)
    expected_move_val = df['Close'].tail(30).std()

    features = ['Close', 'RSI', 'MACD', 'MACD_Signal', 'SMA_20', 'SMA_50', 'SMA_200', 'BBL', 'BBM', 'BBU']
    current_features = df[features].tail(1).values

    # Check if models exist
    rf_path = os.path.join(MODELS_DIR, f"{ticker}_rf.joblib")
    lstm_path = os.path.join(MODELS_DIR, f"{ticker}_lstm.keras")

    if os.path.exists(rf_path) and os.path.exists(lstm_path):
        rf = joblib.load(rf_path)
        scaler_X = joblib.load(os.path.join(MODELS_DIR, f"{ticker}_scaler_X.joblib"))
        scaler_y = joblib.load(os.path.join(MODELS_DIR, f"{ticker}_scaler_y.joblib"))
        lstm = load_model(lstm_path)
    else:
        rf, lstm, scaler_X, scaler_y = train_models(ticker, df)

    # Scaled input for RF
    current_scaled = scaler_X.transform(current_features)
    rf_pred_scaled = rf.predict(current_scaled)

    # Scaled input for LSTM
    window_size = 60
    lstm_input = scaler_X.transform(df[features].tail(window_size).values)
    lstm_input = np.reshape(lstm_input, (1, window_size, len(features)))
    lstm_pred_scaled = lstm.predict(lstm_input, verbose=0)

    # Ensemble (Average)
    ensemble_pred_scaled = (rf_pred_scaled + lstm_pred_scaled) / 2
    final_preds = scaler_y.inverse_transform(ensemble_pred_scaled)[0]

    # Confidence
    diff = np.abs(rf_pred_scaled - lstm_pred_scaled).mean()
    confidence = max(0, 1 - diff * 2) # Adjusted heuristic

    sentiment = get_sentiment(ticker)

    output = {
        "ticker": ticker,
        "forecast": {
            "next_day": round(float(final_preds[0]), 2),
            "next_week": round(float(final_preds[1]), 2)
        },
        "indicators": {
            "rsi": round(float(df['RSI'].iloc[-1]), 2),
            "sentiment": round(float(sentiment), 2)
        },
        "expected_move": f"+/- {round(float(expected_move_val), 2)}",
        "confidence": round(float(confidence), 2)
    }

    return output

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Ticker symbol required"}))
        sys.exit(1)

    ticker = sys.argv[1]
    try:
        result = predict(ticker)
        print(json.dumps(result))
    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "trace": traceback.format_exc()}))
        sys.exit(1)
