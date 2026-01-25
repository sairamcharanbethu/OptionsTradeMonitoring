import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Save, Loader2, User as UserIcon } from 'lucide-react';
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
    const [pollInterval, setPollInterval] = useState('60');

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
                setQtSaved(true);
            }
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
            alert('Please enter your Questrade Consumer Key first.');
            return;
        }

        setQtConnecting(true);
        try {
            // Save client ID first
            await api.saveQuestradeClient(qtClientId);

            const redirectUri = window.location.origin + window.location.pathname;
            const authUrl = `https://login.questrade.com/oauth2/authorize?client_id=${qtClientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}`;

            window.location.href = authUrl;
        } catch (err) {
            console.error(err);
            setQtConnecting(false);
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
                market_poll_interval: pollInterval
            });
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
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Settings</DialogTitle>
                    <DialogDescription>
                        Manage your application preferences and account security.
                    </DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="ai" className="w-full">
                    <TabsList className="grid w-full grid-cols-3 mb-4">
                        <TabsTrigger value="ai">AI Setup</TabsTrigger>
                        <TabsTrigger value="integrations">Integrations</TabsTrigger>
                        <TabsTrigger value="account">Account</TabsTrigger>
                    </TabsList>

                    <TabsContent value="ai">
                        {loading ? (
                            <div className="flex justify-center py-8">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                            </div>
                        ) : (
                            <div className="grid gap-6 py-2">
                                <section className="space-y-4">
                                    <div className="grid gap-4">
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
                                                placeholder={provider === 'ollama' ? 'mistral:latest' : 'anthropic/claude-3-haiku'}
                                            />
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
                                    </div>
                                    <div className="grid gap-2 pt-2 border-t mt-4">
                                        <Label htmlFor="pollInterval" className="flex items-center gap-2">
                                            Market Poll Interval
                                            {parseInt(pollInterval) < 30 && (
                                                <Badge variant="destructive" className="text-[8px] h-4">High Risk</Badge>
                                            )}
                                        </Label>
                                        <Select value={pollInterval} onValueChange={setPollInterval}>
                                            <SelectTrigger>
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
                                    <Button className="w-full mt-2" onClick={handleSaveSettings} disabled={saving || loading}>
                                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                        Save AI Configuration
                                    </Button>
                                </section>
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="integrations">
                        <div className="grid gap-6 py-2">
                            <section className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-sm font-semibold">Brokerage (Questrade)</h3>
                                    <Badge variant={qtSaved ? "outline" : "secondary"}>
                                        {qtSaved ? "Configured" : "Not Linked"}
                                    </Badge>
                                </div>

                                <div className="grid gap-4 p-4 border rounded-lg bg-muted/30">
                                    <div className="grid gap-2">
                                        <Label htmlFor="qt-client">Consumer Key (Client ID)</Label>
                                        <Input
                                            id="qt-client"
                                            value={qtClientId}
                                            onChange={(e) => setQtClientId(e.target.value)}
                                            placeholder="Your Questrade API key"
                                            type="password"
                                        />
                                        <p className="text-[10px] text-muted-foreground">
                                            Found in the Questrade API Center as "Consumer Key".
                                        </p>
                                    </div>

                                    <Button
                                        onClick={initiateQuestradeLogin}
                                        disabled={qtConnecting}
                                        className="w-full bg-[#ffcc00] text-black hover:bg-[#e6b800] font-bold"
                                    >
                                        {qtConnecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                        Connect Questrade
                                    </Button>

                                    <p className="text-[10px] text-center text-muted-foreground italic">
                                        This will redirect you to Questrade to authorize this application.
                                    </p>
                                </div>

                                <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded text-[11px] text-blue-200">
                                    <strong>Note:</strong> Replacing Yahoo Finance with Questrade provides
                                    real-time (or delayed) data from a licensed broker.
                                </div>
                            </section>
                        </div>
                    </TabsContent>

                    <TabsContent value="account">
                        <div className="grid gap-6 py-2 overflow-y-auto max-h-[400px] pr-1">
                            {/* Update Username */}
                            <section className="space-y-4">
                                <h3 className="text-sm font-semibold flex items-center gap-2">
                                    <UserIcon className="h-4 w-4" />
                                    Profile Information
                                </h3>
                                <div className="grid gap-2">
                                    <Label htmlFor="username">Username</Label>
                                    <div className="flex gap-2">
                                        <Input
                                            id="username"
                                            value={username}
                                            onChange={(e) => setUsername(e.target.value)}
                                        />
                                        <Button
                                            variant="secondary"
                                            size="sm"
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

                            <div className="h-px bg-border my-2" />

                            {/* Update Password */}
                            <section className="space-y-4">
                                <h3 className="text-sm font-semibold flex items-center gap-2">
                                    <Save className="h-4 w-4" />
                                    Security & Password
                                </h3>
                                <div className="grid gap-4">
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
                                        variant="secondary"
                                        className="w-full"
                                        onClick={handlePasswordChange}
                                        disabled={changing}
                                    >
                                        {changing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                        Change Password
                                    </Button>
                                </div>
                            </section>
                        </div>
                    </TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}
