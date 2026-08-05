
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
        <div className={`double-bezel-shell hover-glow h-full min-w-0 ${className || ''}`}>
            <div className="double-bezel-core flex h-full min-w-0 flex-col justify-between border border-black/[0.02] bg-zinc-50/50 p-3 dark:border-white/[0.02] dark:bg-zinc-950/40 sm:p-6">
                <div className="flex min-w-0 items-start justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-[0.15em] font-bold text-muted-foreground/90">{title}</span>
                    <div className="flex shrink-0 items-center justify-center rounded-lg border border-black/[0.03] bg-black/5 p-1.5 dark:border-white/[0.06] dark:bg-white/5">
                        <Icon className="h-3.5 w-3.5 text-foreground/85" />
                    </div>
                </div>
                <div className="mt-3 min-w-0 sm:mt-4">
                    <div className={`break-words font-sans text-lg font-extrabold tracking-tight text-foreground/95 sm:text-2xl ${valueClassName || ''}`}>
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
