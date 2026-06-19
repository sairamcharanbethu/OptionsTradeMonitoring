import asyncio
import datetime as dt
import math
import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from starlette.concurrency import run_in_threadpool
from thetadata import ThetaClient


app = FastAPI(title="ThetaData Python Bridge")

_client: Optional[ThetaClient] = None
_client_lock = asyncio.Lock()


async def get_client() -> ThetaClient:
    global _client
    if _client is not None:
        return _client

    async with _client_lock:
        if _client is None:
            kwargs: Dict[str, Any] = {"dataframe_type": os.getenv("THETADATA_DATAFRAME_TYPE", "polars")}
            api_key = os.getenv("THETADATA_API_KEY") or os.getenv("THETA_DATA_API_KEY")
            if api_key:
                kwargs["api_key"] = api_key
            email = os.getenv("THETADATA_EMAIL") or os.getenv("THETADATA_USERNAME")
            password = os.getenv("THETADATA_PASSWORD")
            if not api_key and email and password:
                kwargs["email"] = email
                kwargs["password"] = password
            kwargs["mdds_type"] = os.getenv("THETADATA_MDDS_TYPE") or "PROD"
            _client = await run_in_threadpool(lambda: ThetaClient(**kwargs))
        return _client


def parse_date(value: str) -> dt.date:
    raw = str(value or "").strip()
    if not raw or raw == "*":
        raise HTTPException(status_code=400, detail="A concrete expiration date is required")
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return dt.datetime.strptime(raw, fmt).date()
        except ValueError:
            pass
    raise HTTPException(status_code=400, detail=f"Invalid date: {value}")


def normalize_right(value: str) -> str:
    raw = str(value or "both").strip().lower()
    if raw in ("c", "call"):
        return "call"
    if raw in ("p", "put"):
        return "put"
    return "both"


def normalize_strike(value: Any) -> str:
    raw = str(value or "*").strip()
    if raw == "*":
        return raw
    numeric = float(raw)
    if numeric > 10000:
        numeric = numeric / 1000
    return f"{numeric:.3f}".rstrip("0").rstrip(".")


def dataframe_rows(frame: Any) -> List[Dict[str, Any]]:
    if frame is None:
        return []
    if hasattr(frame, "to_dicts"):
        rows = frame.to_dicts()
    elif hasattr(frame, "to_dict"):
        rows = frame.to_dict(orient="records")
    else:
        rows = list(frame)
    return [json_ready(row) for row in rows]


def json_ready(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): json_ready(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_ready(v) for v in value]
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


async def get_option_quote_rows(symbol: str, expiration: str, strike: Any, right: str) -> List[Dict[str, Any]]:
    client = await get_client()
    kwargs = {
        "symbol": symbol.upper(),
        "expiration": parse_date(expiration),
        "strike": normalize_strike(strike),
        "right": normalize_right(right),
    }
    frame = await run_in_threadpool(lambda: client.option_snapshot_quote(**kwargs))
    return dataframe_rows(frame)


def quote_payload(row: Dict[str, Any], contract: Dict[str, Any]) -> Dict[str, Any]:
    quote = {
        "bid": row.get("bid"),
        "ask": row.get("ask"),
        "bid_size": row.get("bid_size"),
        "ask_size": row.get("ask_size"),
        "timestamp": row.get("timestamp"),
    }
    if row.get("last") is not None:
        quote["last"] = row.get("last")
    return {"header": {"type": "QUOTE"}, "contract": contract, "quote": quote}


@app.get("/health")
async def health() -> Dict[str, Any]:
    try:
        await get_client()
        return {"status": "UP", "provider": "thetadata-python"}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/v3/terminal/mdds/status", response_class=PlainTextResponse)
async def mdds_status() -> str:
    try:
        await get_client()
        return "CONNECTED"
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/v3/option/snapshot/quote")
async def option_snapshot_quote(
    symbol: str = Query(...),
    expiration: str = Query(...),
    right: str = Query("both"),
    strike: str = Query("*"),
) -> Dict[str, Any]:
    try:
        rows = await get_option_quote_rows(symbol, expiration, strike, right)
        return {"response": rows}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.get("/v3/option/history/ohlc")
async def option_history_ohlc(
    symbol: str = Query(...),
    expiration: str = Query(...),
    right: str = Query("both"),
    strike: str = Query("*"),
    start_date: str = Query(...),
    end_date: str = Query(...),
    interval: str = Query("5m"),
) -> Dict[str, Any]:
    try:
        client = await get_client()
        kwargs = {
            "symbol": symbol.upper(),
            "expiration": parse_date(expiration),
            "strike": normalize_strike(strike),
            "right": normalize_right(right),
            "interval": interval,
            "start_date": parse_date(start_date),
            "end_date": parse_date(end_date),
        }
        frame = await run_in_threadpool(lambda: client.option_history_ohlc(**kwargs))
        return {"response": dataframe_rows(frame)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@app.websocket("/v1/events")
async def theta_events(websocket: WebSocket) -> None:
    await websocket.accept()
    subscriptions: Dict[int, Dict[str, Any]] = {}
    poll_interval = float(os.getenv("THETADATA_STREAM_POLL_SECONDS", "2"))
    poll_task = asyncio.create_task(poll_subscriptions(websocket, subscriptions, poll_interval))
    try:
        while True:
            message = await websocket.receive_json()
            request_id = int(message.get("id") or len(subscriptions) + 1)
            contract = message.get("contract") or {}
            if message.get("add", True):
                subscriptions[request_id] = contract
            else:
                subscriptions.pop(request_id, None)
            await websocket.send_json({"header": {"type": "STATUS", "status": "OK"}, "id": request_id})
    except WebSocketDisconnect:
        pass
    finally:
        poll_task.cancel()


async def poll_subscriptions(websocket: WebSocket, subscriptions: Dict[int, Dict[str, Any]], interval: float) -> None:
    while True:
        await asyncio.sleep(max(1, interval))
        for contract in list(subscriptions.values()):
            try:
                rows = await get_option_quote_rows(
                    str(contract.get("root") or contract.get("symbol") or ""),
                    str(contract.get("expiration") or ""),
                    contract.get("strike") or "*",
                    str(contract.get("right") or "both"),
                )
                if rows:
                    await websocket.send_json(quote_payload(rows[0], contract))
            except Exception as exc:
                await websocket.send_json({"header": {"status": "ERROR"}, "error": str(exc), "contract": contract})
