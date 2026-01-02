import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Save, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

export default function SettingsDialog() {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    // Config State
    const [provider, setProvider] = useState('ollama');
    const [openRouterKey, setOpenRouterKey] = useState('');
    const [model, setModel] = useState('mistral:7b-instruct-q4_K_M');
    // We can add more fields as needed

    useEffect(() => {
        if (open) {
            loadSettings();
        }
    }, [open]);

    async function loadSettings() {
        setLoading(true);
        try {
            const data = await api.getSettings();
            setProvider(data.ai_provider || 'ollama');
            setOpenRouterKey(data.openrouter_key || '');
            setModel(data.ai_model || 'mistral:7b-instruct-q4_K_M');
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    }

    async function handleSave() {
        setSaving(true);
        try {
            await api.updateSettings({
                ai_provider: provider,
                openrouter_key: openRouterKey,
                ai_model: model
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
                    <DialogTitle>System Configuration</DialogTitle>
                    <DialogDescription>
                        Configure AI providers and application settings.
                    </DialogDescription>
                </DialogHeader>

                {loading ? (
                    <div className="flex justify-center py-8">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <div className="grid gap-4 py-4">
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
                                <p className="text-[10px] text-muted-foreground">
                                    Keys are stored locally in your database.
                                </p>
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
                            <p className="text-[10px] text-muted-foreground">
                                {provider === 'ollama'
                                    ? 'Must match a model pulled in Ollama.'
                                    : 'e.g., anthropic/claude-3-haiku, openai/gpt-4o'}
                            </p>
                        </div>
                    </div>
                )}

                <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                    <Button onClick={handleSave} disabled={saving || loading}>
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save Changes
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
