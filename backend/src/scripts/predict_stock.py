
import sys
import json
import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestClassifier

# News sentiment imports
try:
    import yfinance as yf
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    HAS_SENTIMENT = True
except ImportError:
    HAS_SENTIMENT = False

def calculate_rsi(data, window=14):
    delta = data.diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=window).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=window).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))

def calculate_ema(data, window):
    return data.ewm(span=window, adjust=False).mean()

def fetch_news_sentiment(symbol):
    """
    Fetch news headlines from Yahoo Finance and analyze sentiment using VADER.
    Returns aggregate sentiment and individual headlines.
    """
    if not HAS_SENTIMENT:
        return {
            "available": False,
            "error": "vaderSentiment or yfinance not installed",
            "aggregate_score": 0,
            "sentiment": "Neutral",
            "headlines": []
        }
    
    try:
        ticker = yf.Ticker(symbol)
        news = ticker.news
        
        if not news:
            return {
                "available": True,
                "aggregate_score": 0,
                "sentiment": "Neutral",
                "headline_count": 0,
                "headlines": [],
                "message": "No recent news found"
            }
        
        analyzer = SentimentIntensityAnalyzer()
        headlines_with_sentiment = []
        compound_scores = []
        
        # Process up to 10 most recent headlines
        for item in news[:10]:
            title = item.get('title', '')
            if title:
                scores = analyzer.polarity_scores(title)
                compound = scores['compound']
                compound_scores.append(compound)
                
                # Determine individual headline sentiment
                if compound >= 0.05:
                    sent_label = "Bullish"
                elif compound <= -0.05:
                    sent_label = "Bearish"
                else:
                    sent_label = "Neutral"
                
                headlines_with_sentiment.append({
                    "title": title[:120],  # Truncate long titles
                    "score": round(compound, 3),
                    "sentiment": sent_label,
                    "published": item.get('providerPublishTime', 0)
                })
        
        # Calculate aggregate sentiment
        if compound_scores:
            avg_score = sum(compound_scores) / len(compound_scores)
        else:
            avg_score = 0
        
        # Determine overall sentiment
        if avg_score >= 0.1:
            overall_sentiment = "Bullish"
        elif avg_score <= -0.1:
            overall_sentiment = "Bearish"
        else:
            overall_sentiment = "Neutral"
        
        return {
            "available": True,
            "aggregate_score": round(avg_score, 3),
            "sentiment": overall_sentiment,
            "headline_count": len(headlines_with_sentiment),
            "headlines": headlines_with_sentiment
        }
        
    except Exception as e:
        return {
            "available": False,
            "error": str(e),
            "aggregate_score": 0,
            "sentiment": "Neutral",
            "headlines": []
        }

def process_and_predict():
    try:
        # Read JSON from stdin
        input_data = sys.stdin.read()
        if not input_data:
            raise ValueError("No input data received")
            
        json_data = json.loads(input_data)
        
        # Extract symbol if provided (for news fetch)
        symbol = json_data.get('symbol', 'UNKNOWN') if isinstance(json_data, dict) else 'UNKNOWN'
        price_data = json_data.get('data', json_data) if isinstance(json_data, dict) else json_data
        
        # Fetch news sentiment
        news_sentiment = fetch_news_sentiment(symbol)
        
        # Convert to DataFrame
        df = pd.DataFrame(price_data)
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
        
        # Add news sentiment as a feature (constant for all rows in current dataset)
        # This represents current market sentiment from recent news
        sentiment_score = news_sentiment.get('aggregate_score', 0)
        df['News_Sentiment'] = sentiment_score
        predictors.append('News_Sentiment')

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
        
        # Simply return the prediction and probabilities
        probability_up = float(preds[0])
        
        # Combine ML sentiment with news sentiment for final verdict
        combined_score = probability_up
        if news_sentiment.get('available', False):
            # Weight: 70% ML, 30% News Sentiment (normalized to 0-1)
            news_normalized = (sentiment_score + 1) / 2  # Convert -1 to 1 range to 0 to 1
            combined_score = 0.7 * probability_up + 0.3 * news_normalized
        
        if combined_score > 0.55:
            sentiment = "Bullish"
        elif combined_score < 0.45:
            sentiment = "Bearish"
        else:
            sentiment = "Neutral"
        
        result = {
            "prediction_probability_up": probability_up,
            "combined_score": round(combined_score, 3),
            "sentiment": sentiment,
            "features": {
                "rsi": float(test['RSI'].iloc[0]) if not pd.isna(test['RSI'].iloc[0]) else 0,
                "close_ratio_5": float(test['Close_Ratio_5'].iloc[0]),
                "trend_5": float(test['Trend_5'].iloc[0]),
                "news_sentiment": sentiment_score
            },
            "news_analysis": news_sentiment
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
