import { FastifyInstance } from 'fastify';
import { redis } from '../lib/redis';

type DiscordAlertSeverity = 'info' | 'warning' | 'critical';

type DiscordAlertInput = {
  userId: number;
  title: string;
  message: string;
  severity?: DiscordAlertSeverity;
  category?: string;
  tradeId?: number | string | null;
  signalId?: number | string | null;
  metadata?: Record<string, any>;
  dedupeKey?: string;
  dedupeSeconds?: number;
};

const severityColor = (severity: DiscordAlertSeverity) => {
  if (severity === 'critical') return 0xef4444;
  if (severity === 'warning') return 0xf59e0b;
  return 0x3b82f6;
};

const DISCORD_ALERT_TIMEOUT_MS = Number(process.env.DISCORD_ALERT_TIMEOUT_MS || 5000);

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

export class DiscordAlertService {
  constructor(private fastify: FastifyInstance) {}

  private async resolveWebhook(userId: number): Promise<string | null> {
    const { rows } = await this.fastify.pg.query(
      `SELECT key, value
       FROM settings
       WHERE user_id = $1
         AND key IN ('discord_alerts_enabled', 'discord_webhook_url')`,
      [userId]
    );
    const settings = rows.reduce((acc: Record<string, string>, row: any) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    const userWebhook = String(settings.discord_webhook_url || '').trim();
    if (settings.discord_alerts_enabled === 'true' && userWebhook) return userWebhook;
    return String(process.env.DISCORD_ALERT_WEBHOOK_URL || '').trim() || null;
  }

  async send(input: DiscordAlertInput): Promise<boolean> {
    let webhookUrl: string | null = null;
    let dedupeRedisKey: string | null = null;
    try {
      webhookUrl = await this.resolveWebhook(input.userId);
      if (!webhookUrl) return false;

      if (input.dedupeKey && redis.isReady()) {
        dedupeRedisKey = `discord-alert:${input.dedupeKey}`;
        const acquired = await redis.setNX(dedupeRedisKey, String(Date.now()), input.dedupeSeconds || 900);
        if (!acquired) return false;
      }
    } catch (err: any) {
      this.fastify.log.warn(`[DiscordAlertService] Failed to prepare ${input.category || 'alert'} alert: ${err.message || String(err)}`);
      return false;
    }

    const severity = input.severity || 'info';
    const fields = [
      input.category ? { name: 'Category', value: input.category, inline: true } : null,
      input.tradeId ? { name: 'Trade', value: `#${input.tradeId}`, inline: true } : null,
      input.signalId ? { name: 'Signal', value: `#${input.signalId}`, inline: true } : null
    ].filter(Boolean);

    const payload = {
      username: 'SS Trading Alerts',
      embeds: [
        {
          title: truncate(input.title, 256),
          description: truncate(input.message, 3500),
          color: severityColor(severity),
          fields,
          footer: { text: `Severity: ${severity.toUpperCase()}` },
          timestamp: new Date().toISOString()
        }
      ]
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCORD_ALERT_TIMEOUT_MS);
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Discord webhook failed: ${response.status}${detail ? ` - ${detail}` : ''}`);
      }
      return true;
    } catch (err: any) {
      if (dedupeRedisKey) await redis.del(dedupeRedisKey);
      this.fastify.log.warn(`[DiscordAlertService] Failed to send ${input.category || 'alert'} alert: ${err.message || String(err)}`);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
