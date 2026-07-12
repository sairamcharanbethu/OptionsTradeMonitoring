FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json copy-scripts.js ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ca-certificates curl procps && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir scipy yfinance mibian scikit-learn pandas vaderSentiment psycopg2-binary && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

EXPOSE 3001

CMD ["npm", "start"]
