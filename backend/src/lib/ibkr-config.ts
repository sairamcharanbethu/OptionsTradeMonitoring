import { getGlobalSettings } from './settings-utils';

export type IbkrGatewayMode = 'live' | 'paper';

export type IbkrGatewayConfig = {
  mode: IbkrGatewayMode;
  host: string;
  port: number;
  marketDataType: number;
  key: string;
};

function normalizeMode(value?: string | null): IbkrGatewayMode {
  return String(value || '').trim().toLowerCase() === 'paper' ? 'paper' : 'live';
}

function numericPort(value: unknown): number | null {
  const parsed = Number(String(value ?? '').trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function defaultIbkrPort(mode: IbkrGatewayMode): number {
  return mode === 'paper' ? 4004 : 4003;
}

export async function getIbkrGatewayConfig(pg?: any): Promise<IbkrGatewayConfig> {
  let settings: Record<string, string> = {};
  if (pg) {
    try {
      settings = await getGlobalSettings(pg);
    } catch {
      settings = {};
    }
  }

  const settingsMode = String(settings.ibkr_gateway_mode || '').trim();
  const mode = normalizeMode(settingsMode || process.env.IBKR_GATEWAY_MODE);
  const host = String(settings.ibkr_host || process.env.IBKR_HOST || 'ib_gateway').trim() || 'ib_gateway';
  const port = numericPort(settings.ibkr_port)
    || (settingsMode ? defaultIbkrPort(mode) : numericPort(process.env.IBKR_PORT))
    || defaultIbkrPort(mode);
  const marketDataType = Number(process.env.IBKR_MARKET_DATA_TYPE || 1);

  return {
    mode,
    host,
    port,
    marketDataType,
    key: `${mode}:${host}:${port}:${marketDataType}`
  };
}
