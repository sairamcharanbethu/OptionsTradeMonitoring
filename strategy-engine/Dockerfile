FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./
RUN mkdir -p /data/trade

CMD ["python3", "trade_prefetch_service.py", "--output-dir", "/data/trade"]
