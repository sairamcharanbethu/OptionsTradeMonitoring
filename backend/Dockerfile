# Production stage
FROM node:20-slim

# Install Python and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir scipy yfinance mibian

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Copy dependency files and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy pre-built dist folder from the CI runner
COPY dist ./dist

# Create directory for scripts
COPY src/scripts ./src/scripts

EXPOSE 3001

CMD ["npm", "start"]
