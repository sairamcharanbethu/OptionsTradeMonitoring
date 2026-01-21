
import { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import path from 'path';
import { AIService } from './ai-service';

export class MLService {
    private fastify: FastifyInstance;
    private aiService: AIService;

    constructor(fastify: FastifyInstance) {
        this.fastify = fastify;
        this.aiService = new AIService(fastify);
    }

    async getForecast(ticker: string) {
        ticker = ticker.toUpperCase();
        const { rows } = await this.fastify.pg.query(
            "SELECT * FROM ml_predictions WHERE ticker = $1 AND updated_at > NOW() - INTERVAL '1 hour'",
            [ticker]
        );
        if (rows.length > 0 && rows[0].status === 'SUCCESS') return rows[0];
        const { rows: pending } = await this.fastify.pg.query(
            "SELECT * FROM ml_predictions WHERE ticker = $1 AND status = 'PENDING'",
            [ticker]
        );
        if (pending.length > 0) return pending[0];
        await this.startPredictionJob(ticker);
        return { ticker, status: 'PENDING' };
    }

    private async startPredictionJob(ticker: string) {
        await this.fastify.pg.query(
            "INSERT INTO ml_predictions (ticker, status, updated_at) VALUES ($1, 'PENDING', CURRENT_TIMESTAMP) ON CONFLICT (ticker) DO UPDATE SET status = 'PENDING', updated_at = CURRENT_TIMESTAMP",
            [ticker]
        );
        const script = path.join(__dirname, '../scripts/predictor_service.py');
        const proc = spawn('python3', [script, ticker]);
        let out = '', err = '';
        proc.stdout.on('data', (d) => out += d.toString());
        proc.stderr.on('data', (d) => err += d.toString());
        proc.on('close', async (code) => {
            if (code !== 0) {
                await this.fastify.pg.query("UPDATE ml_predictions SET status = 'FAILED', error_message = $1 WHERE ticker = $2", [err.substring(0, 500), ticker]);
                return;
            }
            try {
                const lines = out.trim().split('\n');
                let res = null;
                for (let i = lines.length - 1; i >= 0; i--) {
                    try { res = JSON.parse(lines[i]); if (res && res.status === 'success') break; } catch (e) {}
                }
                if (!res) throw new Error('Invalid ML output');
                const ai = await this.aiService.generatePredictionSummary(ticker, res.forecast, res.indicators);
                await this.fastify.pg.query(
                    `UPDATE ml_predictions SET status = 'SUCCESS', forecast_next_day = $1, forecast_next_week = $2, indicators = $3, expected_move = $4, confidence = $5, ai_summary = $6, updated_at = CURRENT_TIMESTAMP WHERE ticker = $7`,
                    [res.forecast.next_day, res.forecast.next_week, JSON.stringify(res.indicators), res.expected_move, res.confidence, ai, ticker]
                );
            } catch (e: any) {
                await this.fastify.pg.query("UPDATE ml_predictions SET status = 'FAILED', error_message = $1 WHERE ticker = $2", [e.message, ticker]);
            }
        });
    }
}
