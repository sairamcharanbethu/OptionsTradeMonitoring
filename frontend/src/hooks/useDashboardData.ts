import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Position } from '@/lib/api';
import { useRef, useEffect } from 'react';

// Keys
export const QUERY_KEYS = {
    positions: ['positions'],
    portfolioStats: ['portfolioStats'],
    marketStatus: ['marketStatus'],
    briefing: ['briefing'],
};

export function usePositions(refreshInterval = 30000) {
    return useQuery({
        queryKey: QUERY_KEYS.positions,
        queryFn: () => api.getPositions(),
        refetchInterval: refreshInterval,
        staleTime: 10000,
    });
}

// Hook to handle efficient updates (preserving history/price change tracking) if needed
// Or we can just use the raw data and let the component compare.
// The original component had logic to track price changes ('up'/'down').
// We might want to keep that logic in the component or a custom hook that wraps this one.

export function usePortfolioStats() {
    return useQuery({
        queryKey: QUERY_KEYS.portfolioStats,
        queryFn: () => api.getPortfolioStats(),
        refetchInterval: 60000, // Refresh stats less often
    });
}

export function useMarketStatus() {
    return useQuery({
        queryKey: QUERY_KEYS.marketStatus,
        queryFn: () => api.getMarketStatus(),
        refetchInterval: 60000,
    });
}

export function usePrefetchDashboard() {
    const queryClient = useQueryClient();

    const prefetch = async () => {
        await Promise.all([
            queryClient.prefetchQuery({ queryKey: QUERY_KEYS.positions, queryFn: () => api.getPositions() }),
            queryClient.prefetchQuery({ queryKey: QUERY_KEYS.portfolioStats, queryFn: () => api.getPortfolioStats() }),
            queryClient.prefetchQuery({ queryKey: QUERY_KEYS.marketStatus, queryFn: () => api.getMarketStatus() }),
        ]);
    };

    return prefetch;
}
