
import yfinance as yf
import json

try:
    ticker = yf.Ticker("NVDA")
    expirations = ticker.options
    print(json.dumps({"symbol": "NVDA", "expirations": expirations}))
except Exception as e:
    print(str(e))
