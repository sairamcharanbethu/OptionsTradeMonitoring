FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json copy-scripts.js ./
COPY src ./src
RUN npm run build

FROM eclipse-temurin:21-jre AS java-runtime

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ca-certificates curl procps && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir scipy yfinance mibian scikit-learn pandas vaderSentiment psycopg2-binary && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:/opt/venv/bin:$PATH"
ENV THETA_HOME=/opt/thetadata
ENV THETA_MIN_TERMINAL_HEAP=2G
ENV THETA_MAX_TERMINAL_HEAP=6G

COPY --from=java-runtime /opt/java/openjdk /opt/java/openjdk

RUN mkdir -p /opt/thetadata /root/ThetaData/ThetaTerminal /root/.ThetaData/ThetaTerminal

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/options-backend-entrypoint

RUN curl -fsSL --retry 3 --retry-delay 5 \
      -o /opt/thetadata/ThetaTerminalv3.jar \
      https://download-unstable.thetadata.us/ThetaTerminalv3.jar && \
    chmod 644 /opt/thetadata/ThetaTerminalv3.jar && \
    chmod +x /usr/local/bin/options-backend-entrypoint

EXPOSE 3001

ENTRYPOINT ["options-backend-entrypoint"]
