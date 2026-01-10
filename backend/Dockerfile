# Build stage
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN NODE_OPTIONS="--max-old-space-size=4096" npm run build

# Production stage
FROM node:20-slim

# Install Python and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-scipy && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir yfinance mibian

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Create directory for scripts
COPY src/scripts ./src/scripts

EXPOSE 3001

CMD ["npm", "start"]
