
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LucideIcon } from 'lucide-react';

interface StatsCardProps {
    title: string;
    value: string | number | React.ReactNode;
    icon: LucideIcon;
    description?: string;
    className?: string;
    valueClassName?: string;
}

export function StatsCard({
    title,
    value,
    icon: Icon,
    description,
    className,
    valueClassName
}: StatsCardProps) {
    return (
        <div className={`double-bezel-shell hover-glow h-full ${className || ''}`}>
            <div className="double-bezel-core flex flex-col justify-between h-full bg-zinc-50/50 dark:bg-zinc-950/40 border border-black/[0.02] dark:border-white/[0.02]">
                <div className="flex justify-between items-center">
                    <span className="text-[10px] uppercase tracking-[0.15em] font-bold text-muted-foreground/90">{title}</span>
                    <div className="p-1.5 bg-black/5 dark:bg-white/5 rounded-lg border border-black/[0.03] dark:border-white/[0.06] flex items-center justify-center">
                        <Icon className="h-3.5 w-3.5 text-foreground/85" />
                    </div>
                </div>
                <div className="mt-4">
                    <div className={`text-2xl font-extrabold tracking-tight font-sans text-foreground/95 ${valueClassName || ''}`}>
                        {value}
                    </div>
                    {description && (
                        <p className="text-[10px] font-mono text-muted-foreground/75 mt-1">{description}</p>
                    )}
                </div>
            </div>
        </div>
    );
}
