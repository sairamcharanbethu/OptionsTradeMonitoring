
import sys
import json
import yfinance as yf
import mibian
from datetime import datetime

def fetch_option_data(os_ticker):
    try:
        # Example OSI Ticker: AAPL250117C00150000
        # Parse ticker to get underlying, expiration, strike, type
        # Format: Ticker(6 chars) + Year(2) + Month(2) + Day(2) + Type(1) + Strike(8)
        # Note: Underlying ticker length varies. We rely on yfinance parsing for simplicity if possible,
        # but yf option objects don't always give Greeks easily.
        # Let's trust yfinance to give us the basic option data first.
        
        ticker = yf.Ticker(os_ticker)
        
        # 1. Get Option Price & Details
        # fast_info is good for price, but we need IV for Greeks
        # .info often contains impliedVolatility
        info = ticker.info
        last_price = info.get('regularMarketPrice') or info.get('lastPrice') or info.get('open') or 0.0
        
        if not last_price:
            fast = ticker.fast_info
            last_price = fast.last_price

        if not last_price:
             print(json.dumps({"status": "error", "symbol": os_ticker, "message": "Price not found"}))
             return

        # 2. Extract Key Parameters for Black-Scholes
        # We need: Underlying Price, Strike, Interest Rate, Days to Expiry, Volatility
        
        # Underlying Symbol extraction (naive approach, works for standard US equity options)
        # yfinance often stores the underlying symbol in .info['underlyingSymbol']
        underlying_symbol = info.get('underlyingSymbol')
        
        # Fallback parsing if yfinance doesn't give it
        if not underlying_symbol:
            # Simple heuristic: remove last 15 chars (digits + type)
            underlying_symbol = os_ticker[:-15]

        underlying = yf.Ticker(underlying_symbol)
        u_price = underlying.fast_info.last_price
        
        strike = info.get('strikePrice')
        
        # Expiration
        # expireDate is timestamp in info
        expire_ts = info.get('expireDate')
        if expire_ts:
            expiry = datetime.fromtimestamp(expire_ts)
        else:
            # Fallback parsing date from string AAPL[250117]C...
            # date_str = os_ticker[-15:-9]
            # expiry = datetime.strptime(date_str, "%y%m%d")
            # This is risky without strict validation, let's hope yf gave it.
            print(json.dumps({"status": "error", "message": "Could not determine expiration"}))
            return

        days_to_expiry = (expiry - datetime.now()).days
        if days_to_expiry < 0: days_to_expiry = 0
        # Mibian uses days, but avoid 0 division or issues
        days_calc = max(days_to_expiry, 0.01) # Use small fraction if expiring today

        # Volatility (IV)
        # Try to use market IV if available, else standard 30?
        iv = info.get('impliedVolatility')
        if iv:
            iv = iv * 100 # Mibian expects percentage (e.g. 25, not 0.25)
        else:
             # If no IV, we can't calculate Greeks accurately.
             # but we can try to compute IV using Mibian given the price!
             # Interest rate approx 4.5% (risk free)
             bs_iv = mibian.BS([u_price, strike, 4.5, days_calc], callPrice=last_price) if 'C' in os_ticker else \
                     mibian.BS([u_price, strike, 4.5, days_calc], putPrice=last_price)
             iv = bs_iv.impliedVolatility
        
        # 3. Calculate Greeks using Mibian
        # BS([UnderlyingPrice, StrikePrice, InterestRate, DaysToExpiration], volatility=x)
        r = 4.5 # Risk free rate approx
        
        c = mibian.BS([u_price, strike, r, days_calc], volatility=iv)
        
        greeks = {}
        is_call = 'C' in os_ticker.upper() or info.get('currency') == 'C' # basic check, better check strike logic
        # Actually parse 'C' or 'P' from ticker if needed, but yf info usually has optionType
        # Or simplistic check: 
        if 'P' in os_ticker.split(underlying_symbol)[1] and not 'C' in os_ticker.split(underlying_symbol)[1]:
             # weak check but let's assume yf info gives us logic or specific fields
             # Mibian calculates both call and put greeks in the object usually
             pass
        
        # Mibian attributes: .callDelta, .putDelta, .callTheta, etc.
        # We need to filter based on type.
        # Ticker format AAPL...C... or P
        # Let's count back 9 chars: ...[C/P]...
        type_char = os_ticker[-9]
        
        if type_char == 'C':
            greeks = {
                "delta": c.callDelta,
                "theta": c.callTheta,
                "gamma": c.gamma, # Gamma is same for both
                "vega": c.vega
            }
        else:
            greeks = {
                "delta": c.putDelta,
                "theta": c.putTheta,
                "gamma": c.gamma,
                "vega": c.vega
            }

        # 4. Output
        output = {
            "status": "ok",
            "symbol": os_ticker,
            "price": float(last_price),
            "underlying_price": float(u_price),
            "greeks": greeks,
            "iv": float(iv)
        }
        print(json.dumps(output))

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
