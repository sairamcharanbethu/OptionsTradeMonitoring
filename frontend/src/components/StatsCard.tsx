
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
        <Card className={`hover:shadow-md transition-shadow ${className}`}>
            <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex justify-between">
                    {title}
                    <Icon className="h-4 w-4" />
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className={`text-2xl font-bold ${valueClassName}`}>
                    {value}
                </div>
                {description && (
                    <p className="text-xs text-muted-foreground mt-1">{description}</p>
                )}
            </CardContent>
        </Card>
    );
}
