# Options Trade Monitor

A robust, real-time dashboard for tracking options trades, monitoring premiums, calculating Greeks, and performing AI-driven trade analysis.

## 🚀 Features

- **Real-time Monitoring**: Automatically polls option premiums every 15 minutes (customizable) using `yfinance`.
- **Greeks Calculation**: Real-time Delta, Theta, Gamma, and Vega calculations via `mibian`.
- **Smart Alerts**: Integrated stop-loss and take-profit triggers with trailing stop loss support.
- **AI Analysis**: One-click AI trade analysis (via OpenRouter) to evaluate position health based on Greeks and price action.
- **Dual Database Redundancy**: Seamless failover between a primary cloud database (Aiven) and a local backup.
- **Interactive Dashboard**: Modern UI with performance charts, capital exposure analytics, and trade history.
- **Clean OS/Ticker Support**: Handles standard OSI ticker formats for precise option targeting.

## 🛠 Tech Stack

- **Frontend**: React, Vite, Tailwind CSS, Shadcn UI, Recharts, Lucide Icons.
- **Backend**: Node.js (Fastify), TypeScript, PostreSQL.
- **Market Data**: Python integration with `yfinance` and `mibian`.
- **Deployment**: Docker, Docker Compose (Nginx for frontend).

## 📋 Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose.
- API Keys for optional features:
  - **Alpha Vantage** (for stock symbol search).
  - **OpenRouter** (for AI analysis).

## ⚙️ Quick Start

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd OptionsTradeMonitoring
   ```

2. **Configure Environment Variables**:
   Create a `.env` file in the root directory (using the variables found in `docker-compose.yml` or existing `.env`). key variables include:
   - `DATABASE_URL`: Your primary Postgres connection string.
   - `BACKUP_DATABASE_URL`: Local postgres backup connection.
   - `ALPHA_VANTAGE_API_KEY`: For symbol searching.
   - `MARKET_DATA_POLL_INTERVAL`: (optional) defaults to 15m.

3. **Launch with Docker**:
   ```bash
   docker-compose up -d --build
   ```

4. **Access the App**:
   - Frontend: `http://localhost:3000`
   - Backend API: `http://localhost:3001`

## 🏗 Project Structure

```text
├── backend/             # Node.js/Fastify source code
│   ├── src/
│   │   ├── routes/     # API endpoints
│   │   ├── services/   # Business logic (MarketPoller, AIService)
│   │   └── scripts/    # Python integration for market data
├── frontend/            # React/Vite source code
│   ├── src/
│   │   ├── components/ # UI Components (Dashboard, Forms)
│   │   └── lib/        # API client and utils
├── db/                  # Database schemas
└── docker-compose.yml   # Multi-container orchestration
```

## 📊 Monitoring & Performance

The backend includes a `MarketPoller` service that:
- Syncs prices for all `OPEN` and `STOP_TRIGGERED` positions.
- Evaluates stop loss/take profit triggers in real-time.
- Records price history for performance charting.
- Supports targeted single-position refresh.

---

*Built with precision for options traders.*
