import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const GOAL_QUERY_KEYS = {
    goals: ['goals'] as const,
    goalEntries: (goalId: number) => ['goals', goalId, 'entries'] as const,
    goalInsights: (goalId: number) => ['goals', goalId, 'insights'] as const,
};

export function useGoals() {
    return useQuery({
        queryKey: GOAL_QUERY_KEYS.goals,
        queryFn: () => api.getGoals(),
    });
}

export function useGoalEntries(goalId: number | null) {
    return useQuery({
        queryKey: GOAL_QUERY_KEYS.goalEntries(goalId!),
        queryFn: () => api.getGoalEntries(goalId!),
        enabled: !!goalId,
    });
}

export function useGoalInsights(goalId: number | null) {
    return useQuery({
        queryKey: GOAL_QUERY_KEYS.goalInsights(goalId!),
        queryFn: () => api.getGoalInsights(goalId!),
        enabled: !!goalId,
        refetchInterval: 60000, // refresh every minute
    });
}
