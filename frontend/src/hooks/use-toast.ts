import { useState } from "react";

export interface ToastProps {
    title?: string;
    description?: string;
    variant?: "default" | "destructive";
}

export function useToast() {
    const toast = ({ title, description, variant }: ToastProps) => {
        console.log(`[Toast] ${variant === "destructive" ? "ERR: " : ""}${title} - ${description}`);
        // You can add logic here to show a simple alert or a custom UI notification if needed
        if (variant === "destructive") {
            alert(`${title}\n${description}`);
        }
    };

    return { toast };
}
