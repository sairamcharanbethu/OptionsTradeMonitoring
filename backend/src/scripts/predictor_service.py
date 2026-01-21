
import sys
import os
import json
import pandas as pd
import numpy as np
import yfinance as yf
import pandas_ta as ta
from datetime import datetime, timedelta
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import MinMaxScaler
from sklearn.model_selection import train_test_split
import joblib

# Suppress warnings
import warnings
warnings.filterwarnings('ignore')

try:
    import tensorflow as tf
    from tensorflow.keras.models import Sequential
    from tensorflow.keras.layers import LSTM, Dense, Dropout
    HAS_TF = True
except ImportError:
    HAS_TF = False

MODELS_DIR = os.path.join(os.path.dirname(__file__), '../../models')
if not os.path.exists(MODELS_DIR):
    os.makedirs(MODELS_DIR)

def get_sentiment(ticker):
    try:
        t = yf.Ticker(ticker)
        news = t.news[:10]
        if not news:
            return 0.5
        analyzer = SentimentIntensityAnalyzer()
        scores = []
        for n in news:
            title = n.get('title') or n.get('content', {}).get('title', '')
            if not title: continue
            vs = analyzer.polarity_scores(title)
            scores.append(vs['compound'])
        return float((np.mean(scores) + 1) / 2) if scores else 0.5
    except:
        return 0.5

def prepare_data(df):
    df['RSI'] = ta.rsi(df['Close'], length=14)
    macd = ta.macd(df['Close'])
    df['MACD'] = macd['MACD_12_26_9']
    df['SMA_20'] = ta.sma(df['Close'], length=20)
    df['SMA_50'] = ta.sma(df['Close'], length=50)
    df['SMA_200'] = ta.sma(df['Close'], length=200)
    bbands = ta.bbands(df['Close'], length=20, std=2)
    upper_col = [c for c in bbands.columns if c.startswith('BBU')][0]
    lower_col = [c for c in bbands.columns if c.startswith('BBL')][0]
    df['BB_Upper'] = bbands[upper_col]
    df['BB_Lower'] = bbands[lower_col]
    df['Target_1d'] = df['Close'].shift(-1)
    df['Target_5d'] = df['Close'].shift(-5)
    return df.dropna()

def train_rf(X, y, ticker, target_name):
    model_path = os.path.join(MODELS_DIR, f"{ticker}_rf_{target_name}.joblib")
    rf = RandomForestRegressor(n_estimators=100, random_state=42)
    rf.fit(X, y)
    joblib.dump(rf, model_path)
    return rf

def train_lstm(X_scaled, y_scaled, ticker, target_name, lookback=60):
    if not HAS_TF: return None
    model_path = os.path.join(MODELS_DIR, f"{ticker}_lstm_{target_name}.h5")
    X_lstm, y_lstm = [], []
    for i in range(lookback, len(X_scaled)):
        X_lstm.append(X_scaled[i-lookback:i])
        y_lstm.append(y_scaled[i])
    X_lstm, y_lstm = np.array(X_lstm), np.array(y_lstm)
    model = Sequential([
        LSTM(units=50, return_sequences=True, input_shape=(X_lstm.shape[1], X_lstm.shape[2])),
        Dropout(0.2),
        LSTM(units=50),
        Dropout(0.2),
        Dense(units=1)
    ])
    model.compile(optimizer='adam', loss='mean_squared_error')
    model.fit(X_lstm, y_lstm, epochs=5, batch_size=32, verbose=0)
    return model

def main(ticker):
    try:
        df = yf.download(ticker, period="5y", interval="1d")
        if df.empty:
            print(json.dumps({"status": "error", "message": "No data found"}))
            return
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df = prepare_data(df)
        feature_cols = ['Close', 'RSI', 'MACD', 'SMA_20', 'SMA_50', 'SMA_200', 'BB_Upper', 'BB_Lower']
        X = df[feature_cols]
        y1, y5 = df['Target_1d'], df['Target_5d']
        latest_X = X.tail(1)
        scaler_X = MinMaxScaler()
        X_scaled = scaler_X.fit_transform(X)
        scaler_y1 = MinMaxScaler()
        y1_scaled = scaler_y1.fit_transform(y1.values.reshape(-1, 1))
        scaler_y5 = MinMaxScaler()
        y5_scaled = scaler_y5.fit_transform(y5.values.reshape(-1, 1))

        rf1 = train_rf(X, y1, ticker, "1d")
        rf5 = train_rf(X, y5, ticker, "5d")
        pred_rf1, pred_rf5 = rf1.predict(latest_X)[0], rf5.predict(latest_X)[0]

        pred_lstm1, pred_lstm5 = pred_rf1, pred_rf5
        if HAS_TF and len(X_scaled) > 60:
            m1 = train_lstm(X_scaled, y1_scaled, ticker, "1d")
            if m1:
                p1 = m1.predict(X_scaled[-60:].reshape(1, 60, X_scaled.shape[1]), verbose=0)
                pred_lstm1 = float(scaler_y1.inverse_transform(p1)[0][0])
            m5 = train_lstm(X_scaled, y5_scaled, ticker, "5d")
            if m5:
                p5 = m5.predict(X_scaled[-60:].reshape(1, 60, X_scaled.shape[1]), verbose=0)
                pred_lstm5 = float(scaler_y5.inverse_transform(p5)[0][0])

        f1, f5 = (pred_rf1 + pred_lstm1) / 2, (pred_rf5 + pred_lstm5) / 2
        df['Returns'] = df['Close'].pct_change()
        std30 = df['Returns'].tail(30).std()
        expected = float(df['Close'].iloc[-1] * std30)
        sentiment = get_sentiment(ticker)
        rsi = float(df['RSI'].iloc[-1])
        conf = 0.7
        if (rsi < 40 and sentiment > 0.6) or (rsi > 60 and sentiment < 0.4): conf += 0.15

        print(json.dumps({
            "status": "success", "ticker": ticker,
            "forecast": {"next_day": round(f1, 2), "next_week": round(f5, 2)},
            "indicators": {
                "rsi": round(rsi, 2), "sentiment": round(sentiment, 2),
                "macd": round(float(df['MACD'].iloc[-1]), 4),
                "sma20": round(float(df['SMA_20'].iloc[-1]), 2), "sma50": round(float(df['SMA_50'].iloc[-1]), 2),
                "sma200": round(float(df['SMA_200'].iloc[-1]), 2),
                "bb_upper": round(float(df['BB_Upper'].iloc[-1]), 2), "bb_lower": round(float(df['BB_Lower'].iloc[-1]), 2)
            },
            "expected_move": f"+/- {round(expected, 2)}", "confidence": round(conf, 2)
        }))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))

if __name__ == "__main__":
    if len(sys.argv) > 1: main(sys.argv[1])
