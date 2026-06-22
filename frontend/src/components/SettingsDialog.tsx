import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Save, Loader2, User as UserIcon, Sliders, Zap, Key, Lock, AlertTriangle, Link, RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { User } from '@/lib/api';

import { useQueryClient } from '@tanstack/react-query';

interface SettingsDialogProps {
    user: User;
    onUpdate: (user: User) => void;
}

const DEFAULT_AI_PROVIDER = 'openrouter';
const DEFAULT_AI_MODEL = 'deepseek/deepseek-chat';

function formatAccountBalance(account: any) {
    const fallbackBalance = Array.isArray(account?.balances)
        ? account.balances.find((balance: any) => balance?.cash !== null && balance?.cash !== undefined)
        : null;
    const rawBalance = account?.cash_balance ?? fallbackBalance?.cash;
    const numericBalance = rawBalance === null || rawBalance === undefined ? null : Number(rawBalance);
    const currency = account?.cash_balance_currency || fallbackBalance?.currency?.code || account?.raw_data?.currency?.code || account?.raw_data?.balance?.currency || 'CAD';

    if (numericBalance === null || Number.isNaN(numericBalance)) {
        return 'Balance unavailable';
    }

    return new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency,
        maximumFractionDigits: 2
    }).format(numericBalance);
}

function normalizeThetaDataBaseUrl(baseUrl: string) {
    const cleaned = baseUrl.trim().replace(/\/$/, '');
    if (!cleaned) return 'http://127.0.0.1:25503';
    if (/^https?:\/\/thetadata:25510$/i.test(cleaned)) return 'http://127.0.0.1:25503';
    if (/^https?:\/\/(127\.0\.0\.1|localhost):25510$/i.test(cleaned)) return 'http://127.0.0.1:25503';
    return cleaned;
}

function normalizeThetaDataStreamUrl(streamUrl: string) {
    const cleaned = streamUrl.trim();
    if (!cleaned) return '';
    if (/^ws:\/\/((127\.0\.0\.1|localhost):255(10|20)|thetadata:255(10|20))\/v1\/events$/i.test(cleaned)) return '';
    return cleaned.replace(/^ws:\/\/thetadata:/i, 'ws://127.0.0.1:');
}

export default function SettingsDialog({ user, onUpdate }: SettingsDialogProps) {
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [activeSettingsTab, setActiveSettingsTab] = useState('daytrading');
    const isAdmin = user.role === 'ADMIN';

    // Config State
    const [provider, setProvider] = useState(DEFAULT_AI_PROVIDER);
    const [openRouterKey, setOpenRouterKey] = useState('');
    const [model, setModel] = useState(DEFAULT_AI_MODEL);
    const [briefingFrequency, setBriefingFrequency] = useState('disabled');
    const [pollInterval, setPollInterval] = useState('60'); // Market Poll (Global)
    const [pollingEnabled, setPollingEnabled] = useState(true); // Master polling toggle
    const [positionPollInterval, setPositionPollInterval] = useState('2'); // Position Detail Poll (Local)

    // Day Trading State
    const [dayTradingEnabled, setDayTradingEnabled] = useState(true);
    const [dayTradingSymbols, setDayTradingSymbols] = useState('QQQ,SPY');
    const [strikeOffset, setStrikeOffset] = useState('0');
    const [minSignalScore, setMinSignalScore] = useState('70');
    const [tradingStartTime, setTradingStartTime] = useState('09:30');
    const [tradingCutoffTime, setTradingCutoffTime] = useState('16:00');
    const [discordAlertsEnabled, setDiscordAlertsEnabled] = useState(false);
    const [discordWebhookUrl, setDiscordWebhookUrl] = useState('');
    const [sscgexPassword, setSscgexPassword] = useState('');
    const [dayTradingAiEnabled, setDayTradingAiEnabled] = useState(true);
    const [executionBroker, setExecutionBroker] = useState('none');
    const [maxTradesPerDay, setMaxTradesPerDay] = useState('2');
    const [contractsPerTrade, setContractsPerTrade] = useState('1');
    const [orderType, setOrderType] = useState('LIMIT');
    const [entrySlippagePct, setEntrySlippagePct] = useState('3');
    const [takeProfitPct, setTakeProfitPct] = useState('');
    const [stopLossEngineEnabled, setStopLossEngineEnabled] = useState(true);
    const [liveTradingAcknowledged, setLiveTradingAcknowledged] = useState(false);

    // Security & Profile State
    const [username, setUsername] = useState(user.username);
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [changing, setChanging] = useState(false);
    const [updatingProfile, setUpdatingProfile] = useState(false);
    const [pwError, setPwError] = useState<string | null>(null);
    const [pwSuccess, setPwSuccess] = useState<string | null>(null);
    const [profileError, setProfileError] = useState<string | null>(null);
    const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

    // ThetaData State
    const [thetaDataBaseUrl, setThetaDataBaseUrl] = useState('http://127.0.0.1:25503');
    const [thetaDataStreamUrl, setThetaDataStreamUrl] = useState('');

    // SnapTrade State
    const [snaptradeClientId, setSnaptradeClientId] = useState('');
    const [snaptradeConsumerKey, setSnaptradeConsumerKey] = useState('');
    const [snaptradeAutoTrade, setSnaptradeAutoTrade] = useState(false);
    const [snaptradeTradingAccountId, setSnaptradeTradingAccountId] = useState('');
    const [snaptradeAccounts, setSnaptradeAccounts] = useState<any[]>([]);
    const [snaptradeConnecting, setSnaptradeConnecting] = useState(false);
    const [snaptradeSyncing, setSnaptradeSyncing] = useState(false);
    const [snaptradeConnectionStatus, setSnaptradeConnectionStatus] = useState<any>(null);
    const [snaptradeCheckingAccess, setSnaptradeCheckingAccess] = useState(false);
    const [snaptradeResettingAccess, setSnaptradeResettingAccess] = useState(false);
    const selectedSnaptradeAccount = snaptradeAccounts.find((account: any) => account.id === snaptradeTradingAccountId);

    // Alpaca State
    const [alpacaKeyId, setAlpacaKeyId] = useState('');
    const [alpacaSecretKey, setAlpacaSecretKey] = useState('');
    const [alpacaAutoTrade, setAlpacaAutoTrade] = useState(false);
    const [alpacaAutoTradeMode, setAlpacaAutoTradeMode] = useState('instant');

    // Discord testing State
    const [testingDiscord, setTestingDiscord] = useState(false);

    async function handleTestDiscord() {
        if (!discordWebhookUrl) {
            alert('Please enter a Discord Webhook URL first.');
            return;
        }
        setTestingDiscord(true);
        try {
            await api.testDiscordWebhook(discordWebhookUrl);
            alert('Test notification sent successfully to Discord!');
        } catch (err: any) {
            alert(`Failed to send test notification: ${err.message || 'Unknown error'}`);
        } finally {
            setTestingDiscord(false);
        }
    }

    useEffect(() => {
        if (open) {
            loadSettings();
            setPwError(null);
            setPwSuccess(null);
            setProfileError(null);
            setProfileSuccess(null);
            setCurrentPassword('');
            setNewPassword('');
            setUsername(user.username);
        }
    }, [open, user.username, isAdmin]);

    async function loadSettings() {
        setLoading(true);
        try {
            const data = await api.getSettings();
            const appProvider = data.ai_provider || DEFAULT_AI_PROVIDER;
            const appModel = data.ai_model || DEFAULT_AI_MODEL;
            setProvider(appProvider);
            setOpenRouterKey(data.openrouter_key || '');
            setModel(appModel);
            setBriefingFrequency(data.briefing_frequency || 'disabled');
            setPollInterval(data.market_poll_interval || '60');
            setPollingEnabled(data.polling_enabled !== 'false');
            setPositionPollInterval(data.position_poll_interval || '2');
            setSnaptradeClientId(data.snaptrade_client_id || '');
            setSnaptradeConsumerKey(data.snaptrade_consumer_key || '');
            setAlpacaKeyId(data.alpaca_key_id || '');
            setAlpacaSecretKey(data.alpaca_secret_key || '');
            setThetaDataBaseUrl(normalizeThetaDataBaseUrl(data.thetadata_base_url || 'http://127.0.0.1:25503'));
            setThetaDataStreamUrl(normalizeThetaDataStreamUrl(data.thetadata_stream_url || ''));
            setAlpacaAutoTrade(data.alpaca_auto_trade === 'true');
            setAlpacaAutoTradeMode(data.alpaca_auto_trade_mode || 'instant');
            setExecutionBroker(data.execution_broker || 'none');
            setSnaptradeAutoTrade(data.snaptrade_auto_trade === 'true');
            setSnaptradeTradingAccountId(data.snaptrade_trading_account_id || '');
            setMaxTradesPerDay(data.max_trades_per_day || '2');
            setContractsPerTrade(data.contracts_per_trade || '1');
            setOrderType(data.order_type || 'LIMIT');
            setEntrySlippagePct(data.entry_slippage_pct || '3');
            setTakeProfitPct(data.take_profit_pct || '');
            setStopLossEngineEnabled(data.stop_loss_engine_enabled !== 'false');
            setLiveTradingAcknowledged(data.live_trading_acknowledged === 'true');

            // Load Day Trading settings
            setDayTradingEnabled(data.day_trading_enabled !== 'false');
            setDayTradingSymbols(data.day_trading_symbols || 'QQQ,SPY');
            setStrikeOffset(data.strike_offset || '0');
            setMinSignalScore(data.min_signal_score || '70');
            setTradingStartTime(data.trading_start_time || '09:30');
            setTradingCutoffTime(data.trading_cutoff_time || '16:00');
            setDiscordAlertsEnabled(data.discord_alerts_enabled === 'true');
            setDiscordWebhookUrl(data.discord_webhook_url || '');
            setSscgexPassword(data.sscgex_password || '');
            setDayTradingAiEnabled(data.day_trading_ai_enabled !== 'false');

            try {
                const portfolio = await api.getSnaptradePortfolio();
                setSnaptradeAccounts(portfolio.accounts || []);
            } catch {
                setSnaptradeAccounts([]);
            }
            try {
                setSnaptradeConnectionStatus(await api.getSnaptradeConnections());
            } catch {
                setSnaptradeConnectionStatus(null);
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (!snaptradeTradingAccountId && snaptradeAccounts.length === 1) {
            setSnaptradeTradingAccountId(snaptradeAccounts[0].id);
        }
    }, [snaptradeAccounts, snaptradeTradingAccountId]);

    function handleExecutionBrokerChange(value: string) {
        setExecutionBroker(value);
        if (value === 'wealthsimple_snaptrade') {
            setSnaptradeAutoTrade(true);
            setAlpacaAutoTrade(false);
        } else if (value === 'alpaca_paper') {
            setAlpacaAutoTrade(true);
            setSnaptradeAutoTrade(false);
        }
    }

    async function saveSnaptradeCredentials() {
        await api.updateSettings({
            snaptrade_client_id: snaptradeClientId,
            snaptrade_consumer_key: snaptradeConsumerKey
        });
        queryClient.invalidateQueries({ queryKey: ['settings'] });
    }

    async function handleConnectSnaptrade() {
        if (!snaptradeClientId || !snaptradeConsumerKey) {
            alert('Enter the SnapTrade Client ID and Consumer Key first.');
            return;
        }

        setSnaptradeConnecting(true);
        try {
            await saveSnaptradeCredentials();
            const data = await api.connectSnaptrade();
            if (data.redirectURI) {
                window.location.href = data.redirectURI;
            } else {
                alert('Failed to get Wealthsimple connection URL.');
            }
        } catch (err: any) {
            alert(`Failed to connect Wealthsimple: ${err.message || 'Unknown error'}`);
        } finally {
            setSnaptradeConnecting(false);
        }
    }

    async function handleSyncSnaptradeAccounts() {
        if (!snaptradeClientId || !snaptradeConsumerKey) {
            alert('Enter the SnapTrade Client ID and Consumer Key first.');
            return;
        }

        setSnaptradeSyncing(true);
        try {
            await saveSnaptradeCredentials();
            await api.syncSnaptradePortfolio();
            const portfolio = await api.getSnaptradePortfolio();
            const accounts = portfolio.accounts || [];
            setSnaptradeAccounts(accounts);
            if (!snaptradeTradingAccountId && accounts.length === 1) {
                setSnaptradeTradingAccountId(accounts[0].id);
            }
            queryClient.invalidateQueries({ queryKey: ['snaptradePortfolio'] });
        } catch (err: any) {
            alert(`Failed to sync Wealthsimple accounts: ${err.message || 'Unknown error'}`);
        } finally {
            setSnaptradeSyncing(false);
        }
    }

    async function handleCheckSnaptradeAccess() {
        setSnaptradeCheckingAccess(true);
        try {
            setSnaptradeConnectionStatus(await api.getSnaptradeConnections());
        } catch (err: any) {
            alert(`Failed to check Wealthsimple access: ${err.message || 'Unknown error'}`);
        } finally {
            setSnaptradeCheckingAccess(false);
        }
    }

    async function handleResetSnaptradeReadOnlyAccess() {
        const confirmed = window.confirm(
            'This removes read-only Wealthsimple connections from SnapTrade and clears the selected Wealthsimple account. Reconnect afterward to grant trading access. Continue?'
        );
        if (!confirmed) return;

        setSnaptradeResettingAccess(true);
        try {
            const result = await api.resetSnaptradeReadOnlyConnections();
            setSnaptradeTradingAccountId('');
            setSnaptradeAccounts([]);
            setSnaptradeConnectionStatus(await api.getSnaptradeConnections().catch(() => null));
            queryClient.invalidateQueries({ queryKey: ['snaptradePortfolio'] });
            alert(result.message || 'Read-only connection reset complete. Reconnect Wealthsimple trading, then sync accounts.');
        } catch (err: any) {
            alert(`Failed to reset Wealthsimple access: ${err.message || 'Unknown error'}`);
        } finally {
            setSnaptradeResettingAccess(false);
        }
    }

    async function handleUsernameChange() {
        if (!username || username.length < 3) {
            setProfileError('Username must be at least 3 characters');
            return;
        }

        setUpdatingProfile(true);
        setProfileError(null);
        setProfileSuccess(null);
        try {
            const result = await api.updateUsername(username);
            onUpdate(result.user);
            setProfileSuccess('Username updated successfully');
        } catch (err: any) {
            setProfileError(err.message || 'Failed to update username');
        } finally {
            setUpdatingProfile(false);
        }
    }

    async function handlePasswordChange() {
        if (!currentPassword || !newPassword) {
            setPwError('Please fill in both fields');
            return;
        }
        if (newPassword.length < 6) {
            setPwError('New password must be at least 6 characters');
            return;
        }

        setChanging(true);
        setPwError(null);
        setPwSuccess(null);
        try {
            await api.changePassword(currentPassword, newPassword);
            setPwSuccess('Password updated successfully');
            setCurrentPassword('');
            setNewPassword('');
        } catch (err: any) {
            setPwError(err.message || 'Failed to change password');
        } finally {
            setChanging(false);
        }
    }

    async function handleSaveSettings() {
        setSaving(true);
        try {
            await api.updateSettings({
                ai_provider: provider,
                openrouter_key: openRouterKey,
                ai_model: model,
                briefing_frequency: briefingFrequency,
                market_poll_interval: pollInterval,
                polling_enabled: pollingEnabled ? 'true' : 'false',
                position_poll_interval: positionPollInterval,
                snaptrade_client_id: snaptradeClientId,
                snaptrade_consumer_key: snaptradeConsumerKey,
                snaptrade_auto_trade: snaptradeAutoTrade ? 'true' : 'false',
                snaptrade_trading_account_id: snaptradeTradingAccountId,
                alpaca_key_id: alpacaKeyId,
                alpaca_secret_key: alpacaSecretKey,
                thetadata_base_url: thetaDataBaseUrl,
                thetadata_stream_url: thetaDataStreamUrl,
                alpaca_auto_trade: alpacaAutoTrade ? 'true' : 'false',
                alpaca_auto_trade_mode: alpacaAutoTradeMode,
                execution_broker: executionBroker,
                max_trades_per_day: maxTradesPerDay,
                contracts_per_trade: contractsPerTrade,
                order_type: orderType,
                entry_slippage_pct: entrySlippagePct,
                take_profit_pct: takeProfitPct,
                stop_loss_engine_enabled: stopLossEngineEnabled ? 'true' : 'false',
                live_trading_acknowledged: liveTradingAcknowledged ? 'true' : 'false',
                day_trading_enabled: dayTradingEnabled ? 'true' : 'false',
                day_trading_symbols: dayTradingSymbols,
                strike_offset: strikeOffset,
                min_signal_score: minSignalScore,
                trading_start_time: tradingStartTime,
                trading_cutoff_time: tradingCutoffTime,
                discord_alerts_enabled: discordAlertsEnabled ? 'true' : 'false',
                discord_webhook_url: discordWebhookUrl,
                sscgex_password: sscgexPassword,
                day_trading_ai_enabled: dayTradingAiEnabled ? 'true' : 'false',
                day_trading_ai_provider: provider,
                day_trading_ai_model: model,
                day_trading_coach_model: model
            });
            queryClient.invalidateQueries({ queryKey: ['settings'] });
            onUpdate(user); // Force refresh of parent if needed
            setOpen(false);
        } catch (err) {
            alert('Failed to save settings');
        } finally {
            setSaving(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-9 w-9">
                    <Settings className="h-5 w-5 text-muted-foreground" />
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-5xl max-h-[92vh] h-[min(760px,92vh)] flex flex-col p-0 gap-0 overflow-hidden">
                <DialogHeader className="p-5 pb-4 border-b shrink-0">
                    <DialogTitle>Trading settings</DialogTitle>
                    <DialogDescription>
                        Configure scanner behavior, execution routing, broker connections, and account security.
                    </DialogDescription>
                </DialogHeader>

                <Tabs value={activeSettingsTab} onValueChange={setActiveSettingsTab} className="flex-1 flex flex-col md:flex-row overflow-hidden">
                    <TabsList className="flex flex-row md:flex-col w-full md:w-56 overflow-x-auto md:overflow-x-visible justify-start rounded-none border-b md:border-b-0 md:border-r h-auto md:h-full bg-muted/30 p-2 space-x-1 md:space-x-0 md:space-y-1 shrink-0 scrollbar-none">
                        <TabsTrigger value="daytrading" className="w-auto md:w-full justify-center md:justify-start px-3 py-2 text-center md:text-left gap-2 data-[state=active]:bg-background shrink-0 whitespace-nowrap">
                            <Zap className="h-4 w-4 text-muted-foreground" />
                            Day trading
                        </TabsTrigger>
                        <TabsTrigger value="credentials" className="w-auto md:w-full justify-center md:justify-start px-3 py-2 text-center md:text-left gap-2 data-[state=active]:bg-background shrink-0 whitespace-nowrap">
                            <Key className="h-4 w-4 text-muted-foreground" />
                            Connections
                        </TabsTrigger>
                        <TabsTrigger value="preferences" className="w-auto md:w-full justify-center md:justify-start px-3 py-2 text-center md:text-left gap-2 data-[state=active]:bg-background shrink-0 whitespace-nowrap">
                            <Sliders className="h-4 w-4 text-muted-foreground" />
                            App preferences
                        </TabsTrigger>
                        <TabsTrigger value="account" className="w-auto md:w-full justify-center md:justify-start px-3 py-2 text-center md:text-left gap-2 data-[state=active]:bg-background shrink-0 whitespace-nowrap">
                            <Lock className="h-4 w-4 text-muted-foreground" />
                            Account
                        </TabsTrigger>
                    </TabsList>

                    <div className="flex-1 overflow-y-auto p-4 md:p-6">
                        {/* Tab 1: General Preferences */}
                        <TabsContent value="preferences" className="m-0 space-y-6">
                            <div>
                                <h3 className="text-lg font-medium">General Preferences</h3>
                                <p className="text-sm text-muted-foreground">Configure the core AI provider, polling intervals, and general settings.</p>
                            </div>
                            <div className="grid gap-6">
                                <div className="grid gap-2">
                                    <Label htmlFor="provider">AI Provider</Label>
                                    <Select value={provider} onValueChange={setProvider}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select Provider" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="ollama">Local Ollama</SelectItem>
                                            <SelectItem value="openrouter">OpenRouter (Cloud)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                 <div className="grid gap-2">
                                     <Label htmlFor="model">Model Name</Label>
                                     <Input
                                         id="model"
                                         value={model}
                                         onChange={(e) => setModel(e.target.value)}
                                         placeholder={provider === 'ollama' ? 'mistral:latest' : DEFAULT_AI_MODEL}
                                     />
                                     {provider === 'openrouter' && (
                                         <p className="text-[10px] text-muted-foreground mt-1 leading-normal">
                                             Recommended OpenRouter slugs:<br/>
                                             1. <strong>DeepSeek Chat</strong>: <code>{DEFAULT_AI_MODEL}</code><br/>
                                             2. <strong>DeepSeek R1</strong>: <code>deepseek/deepseek-r1</code><br/>
                                             3. <strong>OpenAI GPT-4o</strong>: <code>openai/gpt-4o</code>
                                         </p>
                                     )}
                                 </div>

                                <div className="grid gap-2">
                                    <Label htmlFor="frequency">Morning Briefing Frequency</Label>
                                    <Select value={briefingFrequency} onValueChange={setBriefingFrequency}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select Frequency" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="disabled">Disabled</SelectItem>
                                            <SelectItem value="daily">Daily (Mon-Sun)</SelectItem>
                                            <SelectItem value="every_2_days">Every 2 Days</SelectItem>
                                            <SelectItem value="monday">Every Monday</SelectItem>
                                            <SelectItem value="friday">Every Friday</SelectItem>
                                            <SelectItem value="weekly">Weekly (Monday)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="grid gap-2 pt-4 border-t">
                                    <div className="flex items-center justify-between">
                                        <Label htmlFor="pollingToggle" className="flex items-center gap-2">
                                            Market Polling
                                            {pollingEnabled ? (
                                                <Badge variant="default" className="text-[10px] h-5 bg-emerald-600">Active</Badge>
                                            ) : (
                                                <Badge variant="secondary" className="text-[10px] h-5">Paused</Badge>
                                            )}
                                        </Label>
                                        <Switch
                                            id="pollingToggle"
                                            checked={pollingEnabled}
                                            onCheckedChange={setPollingEnabled}
                                        />
                                    </div>
                                    <p className={`text-[10px] ${!pollingEnabled ? 'text-amber-500 font-semibold' : 'text-muted-foreground'}`}>
                                        {!pollingEnabled
                                            ? 'Polling is paused. No API calls will be made to fetch prices or Greeks.'
                                            : 'Master toggle for all server-side market data polling.'}
                                    </p>
                                </div>

                                <div className="grid gap-2">
                                    <Label htmlFor="pollInterval" className="flex items-center gap-2">
                                        Market Poll Interval
                                        {parseInt(pollInterval) < 30 && (
                                            <Badge variant="destructive" className="text-[10px] h-5">High Risk</Badge>
                                        )}
                                    </Label>
                                    <Select value={pollInterval} onValueChange={setPollInterval} disabled={!pollingEnabled}>
                                        <SelectTrigger className={!pollingEnabled ? 'opacity-50' : ''}>
                                            <SelectValue placeholder="Select Interval" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="1">Every 1 second (Ultra-Aggressive)</SelectItem>
                                            <SelectItem value="5">Every 5 seconds</SelectItem>
                                            <SelectItem value="10">Every 10 seconds</SelectItem>
                                            <SelectItem value="30">Every 30 seconds</SelectItem>
                                            <SelectItem value="60">Every 1 minute (Recommended)</SelectItem>
                                            <SelectItem value="300">Every 5 minutes</SelectItem>
                                            <SelectItem value="900">Every 15 minutes</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="grid gap-2">
                                    <Label htmlFor="posPollInterval" className="flex items-center gap-2">
                                        Position Detail Refresh Rate
                                        {parseInt(positionPollInterval) < 2 && (
                                            <Badge variant="destructive" className="text-[10px] h-5">Max Load</Badge>
                                        )}
                                    </Label>
                                    <Select value={positionPollInterval} onValueChange={setPositionPollInterval}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select Interval" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="2">Every 2 seconds (Default)</SelectItem>
                                            <SelectItem value="5">Every 5 seconds</SelectItem>
                                            <SelectItem value="10">Every 10 seconds</SelectItem>
                                            <SelectItem value="30">Every 30 seconds</SelectItem>
                                            <SelectItem value="0">Manual Only (Disabled)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="text-[10px] text-muted-foreground">
                                        How often an individual Position page auto-refreshes data while open.
                                    </p>
                                </div>
                            </div>
                        </TabsContent>

                        {/* Tab 2: Day Trading Scanner */}
                        <TabsContent value="daytrading" className="m-0 space-y-5">
                            <div>
                                <h3 className="text-lg font-semibold">Day trading</h3>
                                <p className="text-sm text-muted-foreground">Scanner rules, order sizing, and execution routing.</p>
                            </div>
                            <div className="grid gap-5">
                                <section className="rounded-lg border bg-card p-4 space-y-4">
                                    <div>
                                        <h4 className="text-sm font-semibold">Scanner</h4>
                                        <p className="text-[10px] text-muted-foreground">Symbols, strike selection, confidence threshold, and trading window.</p>
                                    </div>

                                <div className="grid gap-2">
                                    <div className="flex items-center justify-between">
                                        <Label htmlFor="dtEnabledToggle" className="flex items-center gap-2">
                                            Day Trading Scanner
                                            {dayTradingEnabled ? (
                                                <Badge variant="default" className="text-[10px] h-5 bg-emerald-600">Enabled</Badge>
                                            ) : (
                                                <Badge variant="secondary" className="text-[10px] h-5">Disabled</Badge>
                                            )}
                                        </Label>
                                        <Switch
                                            id="dtEnabledToggle"
                                            checked={dayTradingEnabled}
                                            onCheckedChange={setDayTradingEnabled}
                                        />
                                    </div>
                                </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div className="grid gap-2">
                                            <Label htmlFor="dtSymbols">Tracked Symbols</Label>
                                            <Input
                                                id="dtSymbols"
                                                value={dayTradingSymbols}
                                                onChange={(e) => setDayTradingSymbols(e.target.value)}
                                                placeholder="QQQ, SPY"
                                            />
                                        </div>

                                        <div className="grid gap-2">
                                            <Label htmlFor="dtMinScore">Minimum Signal Confidence</Label>
                                            <Input
                                                id="dtMinScore"
                                                type="number"
                                                value={minSignalScore}
                                                onChange={(e) => setMinSignalScore(e.target.value)}
                                                placeholder="70"
                                            />
                                        </div>

                                        <div className="grid gap-2">
                                            <Label htmlFor="dtStrikeOffset">Options Strike Offset</Label>
                                            <Select value={strikeOffset} onValueChange={setStrikeOffset}>
                                                <SelectTrigger>
                                                    <SelectValue placeholder="Select Offset" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="-2">ITM 2 Strikes (-2)</SelectItem>
                                                    <SelectItem value="-1">ITM 1 Strike (-1)</SelectItem>
                                                    <SelectItem value="0">At the Money (0)</SelectItem>
                                                    <SelectItem value="1">OTM 1 Strike (+1)</SelectItem>
                                                    <SelectItem value="2">OTM 2 Strikes (+2)</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="grid gap-2">
                                                <Label htmlFor="dtStartTime">Start ET</Label>
                                                <Input
                                                    id="dtStartTime"
                                                    type="time"
                                                    value={tradingStartTime}
                                                    onChange={(e) => setTradingStartTime(e.target.value)}
                                                />
                                            </div>
                                            <div className="grid gap-2">
                                                <Label htmlFor="dtCutoffTime">Cutoff ET</Label>
                                                <Input
                                                    id="dtCutoffTime"
                                                    type="time"
                                                    value={tradingCutoffTime}
                                                    onChange={(e) => setTradingCutoffTime(e.target.value)}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </section>

                                <section className="rounded-lg border bg-card p-4 space-y-4">
                                    <div>
                                        <h4 className="text-sm font-semibold">Execution and risk</h4>
                                        <p className="text-[10px] text-muted-foreground">Route orders and cap exposure before a signal can be executed.</p>
                                    </div>

                                    <div className="space-y-3 rounded-md border border-border/70 bg-muted/10 p-3">
                                        <div>
                                            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Broker execution</h5>
                                            <p className="text-[10px] text-muted-foreground">Choose where approved signals are sent.</p>
                                        </div>
                                        <div className="grid gap-2">
                                            <Label htmlFor="executionBroker">Execution Broker</Label>
                                            <Select value={executionBroker} onValueChange={handleExecutionBrokerChange}>
                                                <SelectTrigger id="executionBroker">
                                                    <SelectValue placeholder="Select Broker" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">No broker execution (Simulated)</SelectItem>
                                                    <SelectItem value="alpaca_paper">Alpaca Paper Trading</SelectItem>
                                                    <SelectItem value="wealthsimple_snaptrade">Wealthsimple via SnapTrade (Live)</SelectItem>
                                                </SelectContent>
                                            </Select>
                                            {executionBroker === 'wealthsimple_snaptrade' && (
                                                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-200">
                                                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                                        <div>
                                                            <div className="flex items-center gap-2 font-semibold">
                                                                <AlertTriangle className="h-4 w-4" />
                                                                Wealthsimple Live needs connection setup
                                                            </div>
                                                            <div className="mt-2 grid gap-1 text-[11px]">
                                                                <span className={snaptradeAutoTrade ? 'text-green-600 dark:text-green-300' : ''}>
                                                                    {snaptradeAutoTrade ? 'OK' : 'Missing'}: Enable live execution
                                                                </span>
                                                                <span className={snaptradeTradingAccountId ? 'text-green-600 dark:text-green-300' : ''}>
                                                                    {snaptradeTradingAccountId ? 'OK' : 'Missing'}: Select synced account
                                                                </span>
                                                                <span className={liveTradingAcknowledged ? 'text-green-600 dark:text-green-300' : ''}>
                                                                    {liveTradingAcknowledged ? 'OK' : 'Missing'}: Acknowledge live trading
                                                                </span>
                                                            </div>
                                                        </div>
                                                        <Button type="button" variant="outline" size="sm" onClick={() => setActiveSettingsTab('credentials')}>
                                                            Open Connections
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="space-y-3 rounded-md border border-border/70 bg-muted/10 p-3">
                                        <div>
                                            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Safety limits</h5>
                                            <p className="text-[10px] text-muted-foreground">Cap trade frequency and contract size before any broker order is attempted.</p>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div className="grid gap-2">
                                                <Label htmlFor="maxTradesPerDay">Max Trades Per Day</Label>
                                                <Input
                                                    id="maxTradesPerDay"
                                                    type="number"
                                                    min="1"
                                                    value={maxTradesPerDay}
                                                    onChange={(e) => setMaxTradesPerDay(e.target.value)}
                                                />
                                            </div>
                                            <div className="grid gap-2">
                                                <Label htmlFor="contractsPerTrade">Contracts Per Trade</Label>
                                                <Input
                                                    id="contractsPerTrade"
                                                    type="number"
                                                    min="1"
                                                    value={contractsPerTrade}
                                                    onChange={(e) => setContractsPerTrade(e.target.value)}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="space-y-3 rounded-md border border-border/70 bg-muted/10 p-3">
                                        <div>
                                            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Entry rules</h5>
                                            <p className="text-[10px] text-muted-foreground">Control entry order type and slippage limits.</p>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div className="grid gap-2">
                                                <Label htmlFor="orderType">Entry Order Type</Label>
                                                <Select value={orderType} onValueChange={setOrderType}>
                                                    <SelectTrigger id="orderType">
                                                        <SelectValue placeholder="Select Order Type" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="LIMIT">Limit</SelectItem>
                                                        <SelectItem value="MARKET">Market</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <div className="grid gap-2">
                                                <Label htmlFor="entrySlippagePct">Entry Slippage Cap (%)</Label>
                                                <Input
                                                    id="entrySlippagePct"
                                                    type="number"
                                                    min="0"
                                                    step="0.5"
                                                    value={entrySlippagePct}
                                                    onChange={(e) => setEntrySlippagePct(e.target.value)}
                                                    disabled={orderType !== 'LIMIT'}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="space-y-3 rounded-md border border-border/70 bg-muted/10 p-3">
                                        <div>
                                            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Risk exits</h5>
                                            <p className="text-[10px] text-muted-foreground">Tune take-profit behavior and automatic stop-loss exits.</p>
                                        </div>
                                        <div className="grid gap-2">
                                            <Label htmlFor="takeProfitPct">Premium Take Profit Override (%)</Label>
                                            <Input
                                                id="takeProfitPct"
                                                type="number"
                                                min="0"
                                                step="1"
                                                value={takeProfitPct}
                                                onChange={(e) => setTakeProfitPct(e.target.value)}
                                                placeholder="Blank = use suggested TP"
                                            />
                                            <p className="text-[10px] text-muted-foreground">
                                                Optional. Example: 20 exits at entry premium +20%. Leave blank to rely on the scanner suggested TP.
                                            </p>
                                        </div>

                                        <div className="grid gap-2 rounded-md border border-border bg-muted/20 p-3">
                                            <div className="flex items-center justify-between gap-3">
                                                <Label htmlFor="stopLossEngineToggle" className="flex items-center gap-2">
                                                    Automatic Stop-Loss Engine
                                                    {stopLossEngineEnabled ? (
                                                        <Badge variant="default" className="h-5 bg-emerald-600 text-[10px]">Enabled</Badge>
                                                    ) : (
                                                        <Badge variant="secondary" className="h-5 text-[10px]">Paused</Badge>
                                                    )}
                                                </Label>
                                                <Switch
                                                    id="stopLossEngineToggle"
                                                    checked={stopLossEngineEnabled}
                                                    onCheckedChange={setStopLossEngineEnabled}
                                                />
                                            </div>
                                            <p className={`text-[10px] ${stopLossEngineEnabled ? 'text-muted-foreground' : 'font-semibold text-amber-500'}`}>
                                                {stopLossEngineEnabled
                                                    ? 'Stop-loss exits can be submitted automatically for this user. Take-profit monitoring also remains active.'
                                                    : 'Automatic stop-loss exits are paused for this user only. Take-profit and trim exits remain active.'}
                                            </p>
                                        </div>
                                    </div>
                                </section>

                                <section className="rounded-lg border bg-card p-4 space-y-4">
                                    <div className="flex items-center justify-between">
                                        <Label htmlFor="dtAiEnabled" className="flex items-center gap-2">
                                            Enable AI Coach Commentary
                                        </Label>
                                        <Switch
                                            id="dtAiEnabled"
                                            checked={dayTradingAiEnabled}
                                            onCheckedChange={setDayTradingAiEnabled}
                                        />
                                    </div>

                                    {dayTradingAiEnabled && (
                                        <div className="grid gap-3 animate-in fade-in slide-in-from-top-2 border-t pt-4">
                                            <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                                                <div className="font-semibold text-foreground">Uses app AI service</div>
                                                <div>Provider: {provider === 'openrouter' ? 'OpenRouter' : 'Local Ollama'}</div>
                                                <div>Model: {model || DEFAULT_AI_MODEL}</div>
                                                <p className="mt-2 text-[10px] leading-normal">
                                                    News classification, macro verdicts, trade plans, and position analysis use this same model.
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </section>
                            </div>
                        </TabsContent>

                        {/* Tab 3: API Keys & Credentials */}
                        <TabsContent value="credentials" className="m-0 space-y-6">
                            <div>
                                <h3 className="text-lg font-semibold">Connections</h3>
                                <p className="text-sm text-muted-foreground">Market data, alerts, and broker account access.</p>
                            </div>

                            <div className="space-y-6">
                                {/* API Keys & Services */}
                                <div className="border rounded-lg p-6 bg-card space-y-4">
                                    <h4 className="font-semibold text-sm border-b pb-2">Market data and AI keys</h4>
                                    
                                    <div className="grid gap-2">
                                        <Label htmlFor="key">OpenRouter API Key</Label>
                                        <Input
                                            id="key"
                                            type="password"
                                            value={openRouterKey}
                                            onChange={(e) => setOpenRouterKey(e.target.value)}
                                            placeholder="sk-or-..."
                                        />
                                    </div>

                                    <div className="grid gap-2 pt-2">
                                        <Label htmlFor="dtGexPassword">GEX Portal Password</Label>
                                        <Input
                                            id="dtGexPassword"
                                            type="password"
                                            value={sscgexPassword}
                                            onChange={(e) => setSscgexPassword(e.target.value)}
                                            placeholder="Enter GEX Portal Password"
                                        />
                                    </div>
                                </div>

                                {/* Discord Webhook */}
                                <div className="border rounded-lg p-6 bg-card space-y-4">
                                    <h4 className="font-semibold text-sm border-b pb-2">Alerts</h4>
                                    
                                    <div className="flex items-center justify-between">
                                        <Label htmlFor="dtDiscordAlerts" className="flex items-center gap-2">
                                            Enable Discord Alerts Webhook
                                        </Label>
                                        <Switch
                                            id="dtDiscordAlerts"
                                            checked={discordAlertsEnabled}
                                            onCheckedChange={setDiscordAlertsEnabled}
                                        />
                                    </div>

                                    {discordAlertsEnabled && (
                                        <div className="grid gap-2 animate-in fade-in slide-in-from-top-2 pt-2">
                                            <Label htmlFor="dtDiscordUrl">Discord Webhook URL</Label>
                                            <div className="flex gap-2">
                                                <Input
                                                    id="dtDiscordUrl"
                                                    type="text"
                                                    value={discordWebhookUrl}
                                                    onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                                                    placeholder="https://discord.com/api/webhooks/..."
                                                    className="flex-1"
                                                />
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    onClick={handleTestDiscord}
                                                    disabled={testingDiscord || !discordWebhookUrl}
                                                    className="shrink-0"
                                                >
                                                    {testingDiscord ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                                                    Test Webhook
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Market data and brokerage integrations */}
                                <div className="border rounded-lg p-6 bg-card space-y-6">
                                    <h4 className="font-semibold text-sm border-b pb-2">Market data and brokerages</h4>
                                    
                                    {/* ThetaData */}
                                    {isAdmin && (
                                        <div className="space-y-3">
                                            <div className="flex items-center justify-between">
                                                <h5 className="font-medium text-sm">ThetaData Market Data</h5>
                                                <Badge variant={thetaDataBaseUrl ? "default" : "secondary"}>
                                                    {thetaDataBaseUrl ? "Configured" : "Not Configured"}
                                                </Badge>
                                            </div>
                                            <div className="grid gap-2 p-4 border rounded-md bg-muted/30">
                                                <div className="grid gap-3 sm:grid-cols-2">
                                                    <div className="space-y-1.5">
                                                        <Label htmlFor="thetadata-base-url">REST URL</Label>
                                                        <Input
                                                            id="thetadata-base-url"
                                                            value={thetaDataBaseUrl}
                                                            onChange={(e) => setThetaDataBaseUrl(e.target.value)}
                                                            placeholder="http://127.0.0.1:25503"
                                                        />
                                                    </div>
                                                    <div className="space-y-1.5">
                                                        <Label htmlFor="thetadata-stream-url">Stream URL</Label>
                                                        <Input
                                                            id="thetadata-stream-url"
                                                            value={thetaDataStreamUrl}
                                                            onChange={(e) => setThetaDataStreamUrl(e.target.value)}
                                                            placeholder="Optional verified v3 stream URL"
                                                        />
                                                    </div>
                                                </div>
                                                <p className="text-[10px] text-muted-foreground leading-normal">
                                                    ThetaData Terminal v3 REST runs inside the backend container on 127.0.0.1:25503. Leave Stream URL blank unless a verified v3 stream endpoint is configured.
                                                </p>
                                            </div>
                                        </div>
                                    )}

                                    {/* SnapTrade */}
                                    <div className={`space-y-3 ${isAdmin ? 'pt-4 border-t' : ''}`}>
                                        <div className="flex items-center justify-between">
                                            <h5 className="font-medium text-sm">Wealthsimple (via SnapTrade)</h5>
                                            <Badge variant={snaptradeClientId && snaptradeConsumerKey ? "default" : "secondary"}>
                                                {snaptradeClientId && snaptradeConsumerKey ? "Configured" : "Not Linked"}
                                            </Badge>
                                        </div>
                                        <div className="grid gap-3 p-4 border rounded-md bg-muted/30">
                                            <div className="grid gap-1">
                                                <Label htmlFor="st-client">SnapTrade Client ID</Label>
                                                <Input
                                                    id="st-client"
                                                    value={snaptradeClientId}
                                                    onChange={(e) => setSnaptradeClientId(e.target.value)}
                                                    placeholder="PERS-..."
                                                    type="text"
                                                />
                                            </div>
                                            <div className="grid gap-1">
                                                <Label htmlFor="st-key">SnapTrade Consumer Key</Label>
                                                <Input
                                                    id="st-key"
                                                    value={snaptradeConsumerKey}
                                                    onChange={(e) => setSnaptradeConsumerKey(e.target.value)}
                                                    placeholder="6KyYeW..."
                                                    type="password"
                                                />
                                            </div>
                                            <p className="text-[10px] text-muted-foreground">
                                                Connect requests SnapTrade trading access. Reconnect if Wealthsimple was linked as read-only.
                                            </p>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    onClick={handleConnectSnaptrade}
                                                    disabled={!snaptradeClientId || !snaptradeConsumerKey || snaptradeConnecting}
                                                    className="gap-2"
                                                >
                                                    {snaptradeConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link className="h-4 w-4" />}
                                                    Connect Wealthsimple Trading
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    onClick={handleSyncSnaptradeAccounts}
                                                    disabled={!snaptradeClientId || !snaptradeConsumerKey || snaptradeSyncing}
                                                    className="gap-2"
                                                >
                                                    <RefreshCw className={`h-4 w-4 ${snaptradeSyncing ? 'animate-spin' : ''}`} />
                                                    {snaptradeSyncing ? 'Syncing...' : 'Sync Accounts'}
                                                </Button>
                                            </div>
                                            <div className="rounded-md border border-border/60 bg-background/70 p-3 space-y-3 text-xs">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <p className="font-semibold">SnapTrade access</p>
                                                        <p className="text-[10px] text-muted-foreground">
                                                            {snaptradeConnectionStatus?.selectedAuthorization
                                                                ? `Selected connection: ${snaptradeConnectionStatus.selectedAuthorization.name}`
                                                                : 'Check after connecting Wealthsimple.'}
                                                        </p>
                                                    </div>
                                                    <Badge variant={snaptradeConnectionStatus?.hasTradeConnection ? 'default' : 'secondary'}>
                                                        {snaptradeConnectionStatus?.hasTradeConnection
                                                            ? 'Trade enabled'
                                                            : snaptradeConnectionStatus?.hasReadOnlyConnection
                                                                ? 'Read-only'
                                                                : 'Unknown'}
                                                    </Badge>
                                                </div>
                                                {snaptradeConnectionStatus?.wealthsimpleConnections?.length > 0 && (
                                                    <div className="space-y-1">
                                                        {snaptradeConnectionStatus.wealthsimpleConnections.map((connection: any) => (
                                                            <div key={connection.id} className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                                                                <span className="truncate">{connection.name || connection.brokerageName || connection.id}</span>
                                                                <span className={connection.type === 'trade' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-300'}>
                                                                    {connection.type || 'unknown'}
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        onClick={handleCheckSnaptradeAccess}
                                                        disabled={!snaptradeClientId || !snaptradeConsumerKey || snaptradeCheckingAccess}
                                                        className="gap-2"
                                                    >
                                                        {snaptradeCheckingAccess ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                                        Check Access
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        onClick={handleResetSnaptradeReadOnlyAccess}
                                                        disabled={!snaptradeClientId || !snaptradeConsumerKey || snaptradeResettingAccess || !snaptradeConnectionStatus?.hasReadOnlyConnection}
                                                        className="gap-2"
                                                    >
                                                        {snaptradeResettingAccess ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
                                                        Reset Read-only
                                                    </Button>
                                                </div>
                                            </div>
                                            <div className="grid gap-3 pt-3 border-t border-border/40">
                                                <div className="flex items-center justify-between">
                                                    <Label htmlFor="snaptrade-auto-trade" className="flex flex-col gap-1 cursor-pointer">
                                                        <span>Enable Wealthsimple Live Execution</span>
                                                        <span className="text-[10px] font-normal text-muted-foreground">Places live single-leg option orders through SnapTrade when selected as the execution broker.</span>
                                                    </Label>
                                                    <Switch
                                                        id="snaptrade-auto-trade"
                                                        checked={snaptradeAutoTrade}
                                                        onCheckedChange={setSnaptradeAutoTrade}
                                                        disabled={!snaptradeClientId || !snaptradeConsumerKey}
                                                    />
                                                </div>

                                                <div className="grid gap-1.5">
                                                    <Label htmlFor="snaptrade-account">Trading Account</Label>
                                                    <Select
                                                        value={snaptradeTradingAccountId}
                                                        onValueChange={setSnaptradeTradingAccountId}
                                                        disabled={snaptradeAccounts.length === 0}
                                                    >
                                                        <SelectTrigger id="snaptrade-account">
                                                            <SelectValue placeholder={snaptradeAccounts.length ? "Select Wealthsimple account" : "Sync portfolio to load accounts"} />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {snaptradeAccounts.map((account: any) => (
                                                                <SelectItem key={account.id} value={account.id}>
                                                                    {account.name || 'Wealthsimple Account'} {account.number ? `(${account.number})` : ''} · {formatAccountBalance(account)}
                                                                </SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                    {selectedSnaptradeAccount && (
                                                        <div className="rounded-md border border-border/60 bg-background/70 p-3 text-xs">
                                                            <div className="flex items-center justify-between gap-3">
                                                                <div className="min-w-0">
                                                                    <p className="font-semibold truncate">
                                                                        {selectedSnaptradeAccount.name || 'Wealthsimple Account'}
                                                                    </p>
                                                                    <p className="text-[10px] text-muted-foreground truncate">
                                                                        {selectedSnaptradeAccount.number ? `Account ${selectedSnaptradeAccount.number}` : selectedSnaptradeAccount.id}
                                                                    </p>
                                                                </div>
                                                                <div className="text-right shrink-0">
                                                                    <p className="text-[10px] text-muted-foreground">Cash Balance</p>
                                                                    <p className="font-bold text-green-600 dark:text-green-400">
                                                                        {formatAccountBalance(selectedSnaptradeAccount)}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                    {executionBroker === 'wealthsimple_snaptrade' && snaptradeAccounts.length === 0 && (
                                                        <p className="text-[10px] text-amber-600 dark:text-amber-300">
                                                            No account is available yet. Connect Wealthsimple, then click Sync Accounts.
                                                        </p>
                                                    )}
                                                </div>

                                                <div className="flex items-center justify-between">
                                                    <Label htmlFor="live-trading-ack" className="flex flex-col gap-1 cursor-pointer">
                                                        <span>Live Trading Acknowledgement</span>
                                                        <span className="text-[10px] font-normal text-muted-foreground">I understand Wealthsimple orders are real live trades and require account/options approval.</span>
                                                    </Label>
                                                    <Switch
                                                        id="live-trading-ack"
                                                        checked={liveTradingAcknowledged}
                                                        onCheckedChange={setLiveTradingAcknowledged}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Alpaca */}
                                    <div className="space-y-3 pt-4 border-t">
                                        <div className="flex items-center justify-between">
                                            <h5 className="font-medium text-sm">Alpaca API (Paper Trading)</h5>
                                            <Badge variant={alpacaKeyId && alpacaSecretKey ? "default" : "secondary"}>
                                                {alpacaKeyId && alpacaSecretKey ? "Configured" : "Not Linked"}
                                            </Badge>
                                        </div>
                                        <div className="grid gap-3 p-4 border rounded-md bg-muted/30">
                                            <div className="grid gap-1">
                                                <Label htmlFor="alpaca-key-id">Alpaca API Key ID</Label>
                                                <Input
                                                    id="alpaca-key-id"
                                                    value={alpacaKeyId}
                                                    onChange={(e) => setAlpacaKeyId(e.target.value)}
                                                    placeholder="Enter Alpaca API Key ID"
                                                    type="text"
                                                />
                                            </div>
                                            <div className="grid gap-1">
                                                <Label htmlFor="alpaca-secret-key">Alpaca API Secret Key</Label>
                                                <Input
                                                    id="alpaca-secret-key"
                                                    value={alpacaSecretKey}
                                                    onChange={(e) => setAlpacaSecretKey(e.target.value)}
                                                    placeholder="Enter Alpaca API Secret Key"
                                                    type="password"
                                                />
                                            </div>
                                            <div className="flex items-center justify-between pt-2 border-t border-border/40">
                                                <Label htmlFor="alpaca-auto-trade" className="flex flex-col gap-1 cursor-pointer">
                                                    <span>Auto-Execute Paper Trades</span>
                                                    <span className="text-[10px] font-normal text-muted-foreground">Automatically place 1-contract paper order on trade signal triggers</span>
                                                </Label>
                                                <Switch
                                                    id="alpaca-auto-trade"
                                                    checked={alpacaAutoTrade}
                                                    onCheckedChange={setAlpacaAutoTrade}
                                                />
                                            </div>
                                            {alpacaAutoTrade && (
                                                <div className="grid gap-1.5 pt-2 border-t border-border/40">
                                                    <Label htmlFor="alpaca-auto-trade-mode">Execution Timing</Label>
                                                    <Select value={alpacaAutoTradeMode} onValueChange={setAlpacaAutoTradeMode}>
                                                        <SelectTrigger id="alpaca-auto-trade-mode">
                                                            <SelectValue placeholder="Select Execution Timing" />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="instant">Instant Entry (Pre-AI) — Minimal Latency</SelectItem>
                                                            <SelectItem value="ai_confirmed">AI-Confirmed Entry (Post-AI) — Adds 2-4s Latency</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                    <p className="text-[10px] text-muted-foreground leading-normal mt-0.5">
                                                        {alpacaAutoTradeMode === 'instant' 
                                                            ? "⚡ Orders are placed instantly when technical scanner identifies a trade signal, ignoring AI wait." 
                                                            : "🧠 Orders wait for the shared AI news and coaching verdict. Requires a GO verdict to execute."}
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </TabsContent>

                        {/* Tab 4: Account Security */}
                        <TabsContent value="account" className="m-0 space-y-8">
                            <div>
                                <h3 className="text-lg font-medium">Account & Security</h3>
                                <p className="text-sm text-muted-foreground">Update your profile and password.</p>
                            </div>

                            {/* Update Username */}
                            <section className="space-y-4">
                                <h3 className="text-sm font-semibold flex items-center gap-2">
                                    <UserIcon className="h-4 w-4" />
                                    Profile Information
                                </h3>
                                <div className="grid gap-2 p-4 border rounded-lg bg-card">
                                    <Label htmlFor="username">Username</Label>
                                    <div className="flex gap-2">
                                        <Input
                                            id="username"
                                            value={username}
                                            onChange={(e) => setUsername(e.target.value)}
                                        />
                                        <Button
                                            variant="secondary"
                                            onClick={handleUsernameChange}
                                            disabled={updatingProfile || username === user.username}
                                        >
                                            {updatingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update'}
                                        </Button>
                                    </div>
                                    {profileError && <p className="text-xs text-destructive">{profileError}</p>}
                                    {profileSuccess && <p className="text-xs text-green-500 font-medium">{profileSuccess}</p>}
                                </div>
                            </section>

                            {/* Update Password */}
                            <section className="space-y-4">
                                <h3 className="text-sm font-semibold flex items-center gap-2">
                                    <Lock className="h-4 w-4" />
                                    Change Password
                                </h3>
                                <div className="grid gap-4 p-4 border rounded-lg bg-card">
                                    <div className="grid gap-2">
                                        <Label htmlFor="current">Current Password</Label>
                                        <Input
                                            id="current"
                                            type="password"
                                            value={currentPassword}
                                            onChange={(e) => setCurrentPassword(e.target.value)}
                                        />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="new">New Password</Label>
                                        <Input
                                            id="new"
                                            type="password"
                                            value={newPassword}
                                            onChange={(e) => setNewPassword(e.target.value)}
                                        />
                                    </div>
                                    {pwError && <p className="text-xs text-destructive">{pwError}</p>}
                                    {pwSuccess && <p className="text-xs text-green-500 font-medium">{pwSuccess}</p>}
                                    <Button
                                        variant="outline"
                                        className="w-full"
                                        onClick={handlePasswordChange}
                                        disabled={changing}
                                    >
                                        {changing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                        Change Password
                                    </Button>
                                </div>
                            </section>
                        </TabsContent>
                    </div>
                </Tabs>

                {/* Unified Footer */}
                <div className="p-4 border-t flex justify-end gap-2 shrink-0 bg-background">
                    <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSaveSettings} disabled={saving || loading}>
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save Changes
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
