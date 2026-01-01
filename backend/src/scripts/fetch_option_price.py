
import sys
import json
import yfinance as yf

def fetch_option_data(os_ticker):
    try:
        # Example OSI Ticker: AAPL250117C00150000
        # yfinance Ticker: AAPL250117C00150000
        # Usually yfinance works directly with OSI ticker format for option symbols
        
        ticker = yf.Ticker(os_ticker)
        
        # Fast info is usually faster and less prone to blocks than full .info
        info = ticker.fast_info
        
        # Try to get the last price
        last_price = info.last_price
        
        # If fast_info fails or returns nothing useful (sometimes happens with options), 
        # fallback to .info which does a full scrape
        if last_price is None or last_price == 0.0:
             full_info = ticker.info
             last_price = full_info.get('regularMarketPrice') or full_info.get('lastPrice') or full_info.get('open')

        if last_price:
             print(json.dumps({
                 "status": "ok",
                 "symbol": os_ticker,
                 "price": float(last_price)
             }))
        else:
             print(json.dumps({
                 "status": "error",
                 "symbol": os_ticker,
                 "message": "Price not found"
             }))

    except Exception as e:
        print(json.dumps({
            "status": "error",
            "symbol": os_ticker,
            "message": str(e)
        }))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"status": "error", "message": "Ticker argument required"}))
        sys.exit(1)
    
    ticker = sys.argv[1]
    fetch_option_data(ticker)
