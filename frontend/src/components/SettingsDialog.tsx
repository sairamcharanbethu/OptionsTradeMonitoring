import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Save, Loader2, User as UserIcon } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { User } from '@/lib/api';

interface SettingsDialogProps {
    user: User;
    onUpdate: (user: User) => void;
}

export default function SettingsDialog({ user, onUpdate }: SettingsDialogProps) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    // Config State
    const [provider, setProvider] = useState('ollama');
    const [openRouterKey, setOpenRouterKey] = useState('');
    const [model, setModel] = useState('mistral:7b-instruct-q4_K_M');
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
    const [polygonApiKey, setPolygonApiKey] = useState('');
    const [sscgexPassword, setSscgexPassword] = useState('');
    const [dayTradingAiEnabled, setDayTradingAiEnabled] = useState(true);
    const [dayTradingAiProvider, setDayTradingAiProvider] = useState('openrouter');
    const [dayTradingAiModel, setDayTradingAiModel] = useState('meta-llama/llama-3.3-70b-instruct');

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

    // Questrade State
    const [qtClientId, setQtClientId] = useState('');
    const [qtConnecting, setQtConnecting] = useState(false);
    const [qtSaved, setQtSaved] = useState(false);

    // SnapTrade State
    const [snaptradeClientId, setSnaptradeClientId] = useState('');
    const [snaptradeConsumerKey, setSnaptradeConsumerKey] = useState('');

    useEffect(() => {
        if (open) {
            loadSettings();
            loadQuestradeConfig();
            setPwError(null);
            setPwSuccess(null);
            setProfileError(null);
            setProfileSuccess(null);
            setCurrentPassword('');
            setNewPassword('');
            setUsername(user.username);
        }
    }, [open, user.username]);

    // Handle OAuth Callback on mount/refresh
    useEffect(() => {
        const hash = window.location.hash;
        if (hash && hash.includes('access_token=')) {
            handleQuestradeCallback(hash);
        }
    }, []);

    async function loadQuestradeConfig() {
        try {
            const config = await api.getQuestradeConfig();
            if (config.clientId) {
                setQtClientId(config.clientId);
            }
            setQtSaved(!!config.isLinked);
        } catch (err) {
            console.error(err);
        }
    }

    async function handleQuestradeCallback(hash: string) {
        setQtConnecting(true);
        try {
            // Parse hash params: #access_token=...&refresh_token=...
            const params = new URLSearchParams(hash.replace('#', '?'));
            const data = {
                access_token: params.get('access_token'),
                refresh_token: params.get('refresh_token'),
                api_server: params.get('api_server'),
                token_type: params.get('token_type'),
                expires_in: params.get('expires_in')
            };

            if (data.access_token && data.refresh_token) {
                await api.saveQuestradeToken(data);
                // Clear hash
                window.history.replaceState(null, '', window.location.pathname + window.location.search);
                await loadQuestradeConfig(); // Refresh status
                setOpen(true); // Re-open dialog
                alert('Questrade connected successfully!');
            }
        } catch (err) {
            console.error('Failed to parse Questrade callback:', err);
        } finally {
            setQtConnecting(false);
        }
    }

    async function initiateQuestradeLogin() {
        if (!qtClientId) {
            alert('Please enter your Questrade Key or Token first.');
            return;
        }

        setQtConnecting(true);
        try {
            // Step 1: Attempt direct manual Refresh Token verification first
            console.log('[Questrade] Attempting direct connection via manual Refresh Token...');
            await api.saveQuestradeManualToken(qtClientId);
            
            // If it succeeds, the token is verified and refreshed successfully
            await loadQuestradeConfig();
            alert('Questrade connected successfully using Refresh Token!');
            setQtConnecting(false);
        } catch (err: any) {
            console.warn('[Questrade] Direct Refresh Token link failed. Checking fallback to redirect OAuth...', err);
            
            // Step 2: Fallback prompt for standard OAuth redirect if it is a Client ID/Consumer Key
            const confirmRedirect = window.confirm(
                `Failed to connect directly: ${err.message}\n\nDo you want to treat this key as a Consumer Key (Client ID) and perform a standard Questrade OAuth Redirect Login?`
            );
            
            if (confirmRedirect) {
                try {
                    await api.saveQuestradeClient(qtClientId);
                    const redirectUri = window.location.origin + window.location.pathname;
                    const authUrl = `https://login.questrade.com/oauth2/authorize?client_id=${qtClientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}`;
                    window.location.href = authUrl;
                } catch (oauthErr) {
                    console.error(oauthErr);
                    alert('OAuth redirect initiation failed.');
                    setQtConnecting(false);
                }
            } else {
                setQtConnecting(false);
            }
        }
    }

    async function loadSettings() {
        setLoading(true);
        try {
            const data = await api.getSettings();
            setProvider(data.ai_provider || 'ollama');
            setOpenRouterKey(data.openrouter_key || '');
            setModel(data.ai_model || 'mistral:7b-instruct-q4_K_M');
            setBriefingFrequency(data.briefing_frequency || 'disabled');
            setPollInterval(data.market_poll_interval || '60');
            setPollingEnabled(data.polling_enabled !== 'false');
            setPositionPollInterval(data.position_poll_interval || '2');
            setSnaptradeClientId(data.snaptrade_client_id || '');
            setSnaptradeConsumerKey(data.snaptrade_consumer_key || '');

            // Load Day Trading settings
            setDayTradingEnabled(data.day_trading_enabled !== 'false');
            setDayTradingSymbols(data.day_trading_symbols || 'QQQ,SPY');
            setStrikeOffset(data.strike_offset || '0');
            setMinSignalScore(data.min_signal_score || '70');
            setTradingStartTime(data.trading_start_time || '09:30');
            setTradingCutoffTime(data.trading_cutoff_time || '16:00');
            setDiscordAlertsEnabled(data.discord_alerts_enabled === 'true');
            setDiscordWebhookUrl(data.discord_webhook_url || '');
            setPolygonApiKey(data.polygon_api_key || '');
            setSscgexPassword(data.sscgex_password || '');
            setDayTradingAiEnabled(data.day_trading_ai_enabled !== 'false');
            setDayTradingAiProvider(data.day_trading_ai_provider || 'openrouter');
            setDayTradingAiModel(data.day_trading_ai_model || 'meta-llama/llama-3.3-70b-instruct');
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
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
                day_trading_enabled: dayTradingEnabled ? 'true' : 'false',
                day_trading_symbols: dayTradingSymbols,
                strike_offset: strikeOffset,
                min_signal_score: minSignalScore,
                trading_start_time: tradingStartTime,
                trading_cutoff_time: tradingCutoffTime,
                discord_alerts_enabled: discordAlertsEnabled ? 'true' : 'false',
                discord_webhook_url: discordWebhookUrl,
                polygon_api_key: polygonApiKey,
                sscgex_password: sscgexPassword,
                day_trading_ai_enabled: dayTradingAiEnabled ? 'true' : 'false',
                day_trading_ai_provider: dayTradingAiProvider,
                day_trading_ai_model: dayTradingAiModel
            });
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
            <DialogContent className="sm:max-w-4xl max-h-[90vh] h-[600px] flex flex-col p-0 gap-0 overflow-hidden">
                <DialogHeader className="p-6 pb-4 border-b shrink-0">
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Manage your application preferences and account security.
                    </DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="ai" orientation="vertical" className="flex-1 flex overflow-hidden">
                    <TabsList className="flex-col w-64 justify-start rounded-none border-r h-full bg-muted/30 p-2 space-y-1">
                        <TabsTrigger value="ai" className="w-full justify-start px-4 py-2 text-left data-[state=active]:bg-background">
                            AI Configuration
                        </TabsTrigger>
                        <TabsTrigger value="daytrading" className="w-full justify-start px-4 py-2 text-left data-[state=active]:bg-background">
                            Day Trading Settings
                        </TabsTrigger>
                        <TabsTrigger value="integrations" className="w-full justify-start px-4 py-2 text-left data-[state=active]:bg-background">
                            Integrations
                        </TabsTrigger>
                        <TabsTrigger value="account" className="w-full justify-start px-4 py-2 text-left data-[state=active]:bg-background">
                            Account & Security
                        </TabsTrigger>
                    </TabsList>

                    <div className="flex-1 overflow-y-auto p-6">
                        <TabsContent value="ai" className="m-0 space-y-6">
                            <div>
                                <h3 className="text-lg font-medium">AI Configuration</h3>
                                <p className="text-sm text-muted-foreground">Configure the AI provider and model settings.</p>
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

                                {provider === 'openrouter' && (
                                    <div className="grid gap-2 animate-in fade-in slide-in-from-top-2">
                                        <Label htmlFor="key">OpenRouter API Key</Label>
                                        <Input
                                            id="key"
                                            type="password"
                                            value={openRouterKey}
                                            onChange={(e) => setOpenRouterKey(e.target.value)}
                                            placeholder="sk-or-..."
                                        />
                                    </div>
                                )}

                                 <div className="grid gap-2">
                                     <Label htmlFor="model">Model Name</Label>
                                     <Input
                                         id="model"
                                         value={model}
                                         onChange={(e) => setModel(e.target.value)}
                                         placeholder={provider === 'ollama' ? 'mistral:latest' : 'anthropic/claude-3.5-sonnet'}
                                     />
                                     {provider === 'openrouter' && (
                                         <p className="text-[10px] text-muted-foreground mt-1 leading-normal">
                                             Recommended OpenRouter slugs:<br/>
                                             1. <strong>Claude 3.5 Sonnet</strong>: <code>anthropic/claude-3.5-sonnet</code><br/>
                                             2. <strong>DeepSeek R1 / V3</strong>: <code>deepseek/deepseek-r1</code> or <code>deepseek/deepseek-chat</code><br/>
                                             3. <strong>OpenAI GPT-4o</strong>: <code>openai/gpt-4o</code><br/>
                                             4. <strong>Gemini 2.0 Flash / Pro 1.5</strong>: <code>google/gemini-2.0-flash-exp</code> or <code>google/gemini-pro-1.5</code>
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
                                    <p className="text-[10px] text-muted-foreground">
                                        AI-generated portfolio summary sent to Discord at 8:30 AM ET.
                                    </p>
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
                                    <p className={`text-[10px] ${parseInt(pollInterval) < 30 ? 'text-destructive font-bold' : 'text-muted-foreground'}`}>
                                        {parseInt(pollInterval) < 30
                                            ? 'Caution: Fast polling may cause Yahoo Finance to block your IP.'
                                            : 'How often the server fetches fresh prices and Greeks.'}
                                    </p>
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

                                <Button className="w-full sm:w-auto" onClick={handleSaveSettings} disabled={saving || loading}>
                                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Save Configuration
                                </Button>
                            </div>
                        </TabsContent>

                        <TabsContent value="integrations" className="m-0 space-y-6">
                            <div>
                                <h3 className="text-lg font-medium">Integrations</h3>
                                <p className="text-sm text-muted-foreground">Manage connections to external services.</p>
                            </div>

                            <div className="space-y-4">
                                <div className="flex items-center justify-between p-4 border rounded-lg bg-card">
                                    <div className="space-y-1">
                                        <h4 className="font-medium">Questrade Brokerage</h4>
                                        <p className="text-sm text-muted-foreground">Connect your Questrade account for real-time data.</p>
                                    </div>
                                    <Badge variant={qtSaved ? "default" : "secondary"}>
                                        {qtSaved ? "Connected" : "Not Linked"}
                                    </Badge>
                                </div>

                                <div className="grid gap-4 p-6 border rounded-lg bg-muted/30">
                                    <div className="grid gap-2">
                                        <Label htmlFor="qt-client">Questrade API Key / Refresh Token</Label>
                                        <Input
                                            id="qt-client"
                                            value={qtClientId}
                                            onChange={(e) => setQtClientId(e.target.value)}
                                            placeholder="Paste your manually generated Refresh Token or Consumer Key"
                                            type="password"
                                        />
                                        <p className="text-[10px] text-muted-foreground leading-normal">
                                            <strong>Recommended:</strong> Click <strong>"New manual authorization"</strong> in your Questrade API Centre, copy the Refresh Token, and paste it here. Or, enter your static **Consumer Key (Client ID)** to use the redirect flow.
                                        </p>
                                    </div>

                                    <Button
                                        onClick={initiateQuestradeLogin}
                                        disabled={qtConnecting}
                                        className="w-full bg-[#ffcc00] text-black hover:bg-[#e6b800] font-bold transition-all duration-200 shadow-md hover:shadow-lg"
                                    >
                                        {qtConnecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                        Connect Questrade
                                    </Button>

                                    <p className="text-[10px] text-center text-muted-foreground italic">
                                        The application will automatically detect, verify, and rotate your token directly.
                                    </p>
                                </div>
                                
                                <div className="flex items-center justify-between p-4 border rounded-lg bg-card mt-6">
                                    <div className="space-y-1">
                                        <h4 className="font-medium">Wealthsimple (via SnapTrade)</h4>
                                        <p className="text-sm text-muted-foreground">Connect your SnapTrade App credentials to enable Wealthsimple.</p>
                                    </div>
                                    <Badge variant={snaptradeClientId && snaptradeConsumerKey ? "default" : "secondary"}>
                                        {snaptradeClientId && snaptradeConsumerKey ? "Configured" : "Not Linked"}
                                    </Badge>
                                </div>

                                <div className="grid gap-4 p-6 border rounded-lg bg-muted/30">
                                    <div className="grid gap-2">
                                        <Label htmlFor="st-client">SnapTrade Client ID</Label>
                                        <Input
                                            id="st-client"
                                            value={snaptradeClientId}
                                            onChange={(e) => setSnaptradeClientId(e.target.value)}
                                            placeholder="PERS-..."
                                            type="text"
                                        />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="st-key">SnapTrade Consumer Key</Label>
                                        <Input
                                            id="st-key"
                                            value={snaptradeConsumerKey}
                                            onChange={(e) => setSnaptradeConsumerKey(e.target.value)}
                                            placeholder="6KyYeW..."
                                            type="password"
                                        />
                                    </div>
                                    <Button className="w-full mt-2" onClick={handleSaveSettings} disabled={saving}>
                                        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                                        Save SnapTrade Keys
                                    </Button>
                                    <p className="text-[10px] text-muted-foreground">
                                        Once saved, go to the Wealthsimple dashboard to securely connect your broker.
                                    </p>
                                </div>
                            </div>
                        </TabsContent>

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
                                <div className="grid gap-2 p-4 border rounded-lg">
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
                                    <Save className="h-4 w-4" />
                                    Change Password
                                </h3>
                                <div className="grid gap-4 p-4 border rounded-lg">
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

                        <TabsContent value="daytrading" className="m-0 space-y-6">
                            <div>
                                <h3 className="text-lg font-medium">Day Trading Scanner</h3>
                                <p className="text-sm text-muted-foreground">Configure the real-time options scanner and alerting parameters.</p>
                            </div>
                            <div className="grid gap-6">
                                <div className="grid gap-2 pt-2">
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
                                    <p className="text-[10px] text-muted-foreground">
                                        Enable/disable background scanning of Day Trading alerts.
                                    </p>
                                </div>

                                <div className="grid gap-2">
                                    <Label htmlFor="dtSymbols">Tracked Symbols (Comma-separated)</Label>
                                    <Input
                                        id="dtSymbols"
                                        value={dayTradingSymbols}
                                        onChange={(e) => setDayTradingSymbols(e.target.value)}
                                        placeholder="QQQ, SPY"
                                    />
                                    <p className="text-[10px] text-muted-foreground">
                                        Underlying indices to scan. Example: <code>QQQ, SPY</code>
                                    </p>
                                </div>

                                <div className="grid gap-2">
                                    <Label htmlFor="dtStrikeOffset">Options Strike Offset</Label>
                                    <Select value={strikeOffset} onValueChange={setStrikeOffset}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select Offset" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="-2">In-The-Money (ITM) 2 Strikes (-2)</SelectItem>
                                            <SelectItem value="-1">In-The-Money (ITM) 1 Strike (-1)</SelectItem>
                                            <SelectItem value="0">At-The-Money (ATM) (0)</SelectItem>
                                            <SelectItem value="1">Out-Of-The-Money (OTM) 1 Strike (+1)</SelectItem>
                                            <SelectItem value="2">Out-Of-The-Money (OTM) 2 Strikes (+2)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="grid gap-2">
                                    <Label htmlFor="dtMinScore">Minimum Signal Confidence Score</Label>
                                    <Input
                                        id="dtMinScore"
                                        type="number"
                                        value={minSignalScore}
                                        onChange={(e) => setMinSignalScore(e.target.value)}
                                        placeholder="70"
                                    />
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div className="grid gap-2">
                                        <Label htmlFor="dtStartTime">Trading Start Time (ET)</Label>
                                        <Input
                                            id="dtStartTime"
                                            type="time"
                                            value={tradingStartTime}
                                            onChange={(e) => setTradingStartTime(e.target.value)}
                                        />
                                    </div>
                                    <div className="grid gap-2">
                                        <Label htmlFor="dtCutoffTime">Trading Cutoff Time (ET)</Label>
                                        <Input
                                            id="dtCutoffTime"
                                            type="time"
                                            value={tradingCutoffTime}
                                            onChange={(e) => setTradingCutoffTime(e.target.value)}
                                        />
                                    </div>
                                </div>

                                <div className="grid gap-2 pt-4 border-t">
                                    <div className="flex items-center justify-between">
                                        <Label htmlFor="dtDiscordAlerts" className="flex items-center gap-2">
                                            Discord Alerts Webhook
                                        </Label>
                                        <Switch
                                            id="dtDiscordAlerts"
                                            checked={discordAlertsEnabled}
                                            onCheckedChange={setDiscordAlertsEnabled}
                                        />
                                    </div>
                                </div>

                                {discordAlertsEnabled && (
                                    <div className="grid gap-2 animate-in fade-in slide-in-from-top-2">
                                        <Label htmlFor="dtDiscordUrl">Discord Webhook URL</Label>
                                        <Input
                                            id="dtDiscordUrl"
                                            type="password"
                                            value={discordWebhookUrl}
                                            onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                                            placeholder="https://discord.com/api/webhooks/..."
                                        />
                                    </div>
                                )}

                                <div className="grid gap-2 pt-4 border-t">
                                    <Label htmlFor="dtPolygonKey">Polygon.io API Key (Required for 0DTE Option quotes)</Label>
                                    <Input
                                        id="dtPolygonKey"
                                        type="password"
                                        value={polygonApiKey}
                                        onChange={(e) => setPolygonApiKey(e.target.value)}
                                        placeholder="Enter Polygon Key"
                                    />
                                </div>

                                <div className="grid gap-2">
                                    <Label htmlFor="dtGexPassword">GEX Portal Password (Required for GEX Walls)</Label>
                                    <Input
                                        id="dtGexPassword"
                                        type="password"
                                        value={sscgexPassword}
                                        onChange={(e) => setSscgexPassword(e.target.value)}
                                        placeholder="Enter GEX Portal Password"
                                    />
                                </div>

                                <div className="grid gap-4 pt-4 border-t">
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
                                </div>

                                {dayTradingAiEnabled && (
                                    <div className="grid gap-4 animate-in fade-in slide-in-from-top-2">
                                        <div className="grid gap-2">
                                            <Label htmlFor="dtAiProvider">AI Provider</Label>
                                            <Select value={dayTradingAiProvider} onValueChange={setDayTradingAiProvider}>
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
                                            <Label htmlFor="dtAiModel">AI Model</Label>
                                            <Input
                                                id="dtAiModel"
                                                value={dayTradingAiModel}
                                                onChange={(e) => setDayTradingAiModel(e.target.value)}
                                                placeholder="meta-llama/llama-3.3-70b-instruct"
                                            />
                                        </div>
                                    </div>
                                )}

                                <Button className="w-full sm:w-auto" onClick={handleSaveSettings} disabled={saving || loading}>
                                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    Save Day Trading Settings
                                </Button>
                            </div>
                        </TabsContent>
                    </div>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}
