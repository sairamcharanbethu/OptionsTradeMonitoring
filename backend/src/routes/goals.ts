import { FastifyInstance } from 'fastify';
import { getUSMarketHolidays, parseMarketDate, tradingDaysBetween } from '../lib/market-calendar';

export { getUSMarketHolidays, parseMarketDate, tradingDaysBetween };

export async function goalRoutes(fastify: FastifyInstance) {
    fastify.addHook('onRequest', (fastify as any).authenticate);

    // ─── GET all goals for current user ───
    fastify.get('/', async (request, reply) => {
        const { id: userId } = (request as any).user;
        try {
            const { rows } = await (fastify as any).pg.query(
                'SELECT * FROM goals WHERE user_id = $1 ORDER BY created_at DESC',
                [userId]
            );
            return rows;
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch goals' });
        }
    });

    // ─── CREATE a new goal ───
    fastify.post('/', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const { name, target_amount, start_date, end_date } = request.body as any;

        if (!name || !target_amount || !start_date || !end_date) {
            return reply.code(400).send({ error: 'name, target_amount, start_date, and end_date are required' });
        }

        try {
            const { rows } = await (fastify as any).pg.query(
                `INSERT INTO goals (user_id, name, target_amount, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [userId, name, target_amount, start_date, end_date]
            );
            return reply.code(201).send(rows[0]);
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to create goal' });
        }
    });

    // ─── UPDATE a goal ───
    fastify.put('/:id', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const goalId = (request.params as any).id;
        const { name, target_amount, start_date, end_date } = request.body as any;

        try {
            const { rows } = await (fastify as any).pg.query(
                `UPDATE goals SET name = COALESCE($1, name), target_amount = COALESCE($2, target_amount),
         start_date = COALESCE($3, start_date), end_date = COALESCE($4, end_date), updated_at = NOW()
         WHERE id = $5 AND user_id = $6 RETURNING *`,
                [name, target_amount, start_date, end_date, goalId, userId]
            );
            if (rows.length === 0) return reply.code(404).send({ error: 'Goal not found' });
            return rows[0];
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to update goal' });
        }
    });

    // ─── DELETE a goal ───
    fastify.delete('/:id', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const goalId = (request.params as any).id;

        try {
            const { rowCount } = await (fastify as any).pg.query(
                'DELETE FROM goals WHERE id = $1 AND user_id = $2',
                [goalId, userId]
            );
            if (rowCount === 0) return reply.code(404).send({ error: 'Goal not found' });
            return { status: 'ok' };
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to delete goal' });
        }
    });

    // ─── GET entries for a goal ───
    fastify.get('/:id/entries', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const goalId = (request.params as any).id;

        try {
            // Verify ownership
            const goal = await (fastify as any).pg.query(
                'SELECT id FROM goals WHERE id = $1 AND user_id = $2', [goalId, userId]
            );
            if (goal.rows.length === 0) return reply.code(404).send({ error: 'Goal not found' });

            const { rows } = await (fastify as any).pg.query(
                'SELECT * FROM goal_entries WHERE goal_id = $1 ORDER BY entry_date DESC',
                [goalId]
            );
            return rows;
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch entries' });
        }
    });

    // ─── ADD an entry ───
    fastify.post('/:id/entries', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const goalId = (request.params as any).id;
        const { entry_date, amount, notes } = request.body as any;

        if (!entry_date || amount == null) {
            return reply.code(400).send({ error: 'entry_date and amount are required' });
        }

        try {
            // Verify ownership
            const goal = await (fastify as any).pg.query(
                'SELECT id FROM goals WHERE id = $1 AND user_id = $2', [goalId, userId]
            );
            if (goal.rows.length === 0) return reply.code(404).send({ error: 'Goal not found' });

            const { rows } = await (fastify as any).pg.query(
                `INSERT INTO goal_entries (goal_id, entry_date, amount, notes)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (goal_id, entry_date)
                 DO UPDATE SET 
                    amount = goal_entries.amount + EXCLUDED.amount,
                    notes = CASE 
                        WHEN goal_entries.notes IS NOT NULL AND goal_entries.notes <> '' 
                        THEN goal_entries.notes || '; ' || EXCLUDED.notes
                        ELSE EXCLUDED.notes
                    END
                 RETURNING *`,
                [goalId, entry_date, amount, notes || '']
            );
            return reply.code(201).send(rows[0]);
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to add entry' });
        }
    });

    // ─── UPDATE an entry ───
    fastify.put('/:id/entries/:entryId', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const goalId = (request.params as any).id;
        const entryId = (request.params as any).entryId;
        const { entry_date, amount, notes } = request.body as any;

        try {
            // Verify ownership
            const goal = await (fastify as any).pg.query(
                'SELECT id FROM goals WHERE id = $1 AND user_id = $2', [goalId, userId]
            );
            if (goal.rows.length === 0) return reply.code(404).send({ error: 'Goal not found' });

            const { rows } = await (fastify as any).pg.query(
                `UPDATE goal_entries SET entry_date = COALESCE($1, entry_date), amount = COALESCE($2, amount),
         notes = COALESCE($3, notes)
         WHERE id = $4 AND goal_id = $5 RETURNING *`,
                [entry_date, amount, notes, entryId, goalId]
            );
            if (rows.length === 0) return reply.code(404).send({ error: 'Entry not found' });
            return rows[0];
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to update entry' });
        }
    });

    // ─── DELETE an entry ───
    fastify.delete('/:id/entries/:entryId', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const goalId = (request.params as any).id;
        const entryId = (request.params as any).entryId;

        try {
            // Verify ownership
            const goal = await (fastify as any).pg.query(
                'SELECT id FROM goals WHERE id = $1 AND user_id = $2', [goalId, userId]
            );
            if (goal.rows.length === 0) return reply.code(404).send({ error: 'Goal not found' });

            const { rowCount } = await (fastify as any).pg.query(
                'DELETE FROM goal_entries WHERE id = $1 AND goal_id = $2',
                [entryId, goalId]
            );
            if (rowCount === 0) return reply.code(404).send({ error: 'Entry not found' });
            return { status: 'ok' };
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to delete entry' });
        }
    });

    // ─── INSIGHTS for a goal ───
    fastify.get('/:id/insights', async (request, reply) => {
        const { id: userId } = (request as any).user;
        const goalId = (request.params as any).id;

        try {
            // Fetch goal
            const goalResult = await (fastify as any).pg.query(
                'SELECT * FROM goals WHERE id = $1 AND user_id = $2', [goalId, userId]
            );
            if (goalResult.rows.length === 0) return reply.code(404).send({ error: 'Goal not found' });
            const goal = goalResult.rows[0];

            // Fetch total earned
            const sumResult = await (fastify as any).pg.query(
                'SELECT COALESCE(SUM(amount), 0) as total_earned FROM goal_entries WHERE goal_id = $1',
                [goalId]
            );
            const totalEarned = parseFloat(sumResult.rows[0].total_earned);
            const targetAmount = parseFloat(goal.target_amount);

            // Fetch all entries for streak & win-rate calculations
            const entriesResult = await (fastify as any).pg.query(
                'SELECT amount FROM goal_entries WHERE goal_id = $1 ORDER BY entry_date ASC',
                [goalId]
            );
            const amounts: number[] = entriesResult.rows.map((r: any) => parseFloat(r.amount));

            // ── Streak calculation ──
            let currentStreak = 0;
            let longestStreak = 0;
            let tempStreak = 0;
            for (let i = 0; i < amounts.length; i++) {
                if (amounts[i] > 0) {
                    tempStreak++;
                    longestStreak = Math.max(longestStreak, tempStreak);
                } else {
                    tempStreak = 0;
                }
            }
            // Current streak = count backwards from the last entry
            for (let i = amounts.length - 1; i >= 0; i--) {
                if (amounts[i] > 0) {
                    currentStreak++;
                } else {
                    break;
                }
            }

            // ── Win rate calculation ──
            const totalEntries = amounts.length;
            const wins = amounts.filter(a => a > 0).length;
            const losses = amounts.filter(a => a < 0).length;
            const breakEven = amounts.filter(a => a === 0).length;
            const winRate = totalEntries > 0 ? (wins / totalEntries) * 100 : 0;
            const avgWin = wins > 0 ? amounts.filter(a => a > 0).reduce((s, a) => s + a, 0) / wins : 0;
            const avgLoss = losses > 0 ? Math.abs(amounts.filter(a => a < 0).reduce((s, a) => s + a, 0)) / losses : 0;
            const profitFactor = avgLoss > 0 ? (avgWin * wins) / (avgLoss * losses) : wins > 0 ? Infinity : 0;

            const now = new Date();
            const startDate = parseMarketDate(goal.start_date);
            const endDate = parseMarketDate(goal.end_date);

            // Use US trading days instead of calendar days
            // We want inclusive of start and end for total duration
            const daysTotal = Math.max(1, tradingDaysBetween(startDate, new Date(endDate.getTime() + 86400000)));

            // Effective now: if goal ended, cap at end date. If future, cap at now.
            let effectiveNow = now < endDate ? now : endDate;
            // Elapsed: Use exclusive of today (effectiveNow) to match user expectation of "completed days".
            // If they want to include today, they can look at Projected. 
            // This aligns "Daily Average" with "Past Performance".
            const daysElapsed = Math.max(1, tradingDaysBetween(startDate, effectiveNow));

            const daysRemaining = Math.max(0, daysTotal - daysElapsed);

            const percentComplete = Math.min(100, (totalEarned / targetAmount) * 100);
            const dailyAverage = totalEarned / daysElapsed;
            const projectedTotal = dailyAverage * daysTotal;
            const remainingPerDay = daysRemaining > 0 ? (targetAmount - totalEarned) / daysRemaining : 0;

            // Expected progress at this point (linear)
            const expectedPercent = Math.min(100, (daysElapsed / daysTotal) * 100);
            const progressDelta = percentComplete - expectedPercent; // positive = ahead, negative = behind

            let status: string;
            if (totalEarned >= targetAmount) {
                status = 'COMPLETED';
            } else if (progressDelta >= 5) {
                status = 'AHEAD';
            } else if (progressDelta >= -5) {
                status = 'ON_TRACK';
            } else if (progressDelta >= -20) {
                status = 'AT_RISK';
            } else {
                status = 'BEHIND';
            }

            return {
                goalId: goal.id,
                goalName: goal.name,
                targetAmount,
                totalEarned,
                percentComplete: Math.round(percentComplete * 100) / 100,
                daysTotal,
                daysElapsed,
                daysRemaining,
                dailyAverage: Math.round(dailyAverage * 100) / 100,
                projectedTotal: Math.round(projectedTotal * 100) / 100,
                remainingPerDay: Math.round(remainingPerDay * 100) / 100,
                expectedPercent: Math.round(expectedPercent * 100) / 100,
                progressDelta: Math.round(progressDelta * 100) / 100,
                status,
                // Streak
                currentStreak,
                longestStreak,
                // Win Rate
                totalEntries,
                wins,
                losses,
                breakEven,
                winRate: Math.round(winRate * 100) / 100,
                avgWin: Math.round(avgWin * 100) / 100,
                avgLoss: Math.round(avgLoss * 100) / 100,
                profitFactor: profitFactor === Infinity ? null : Math.round(profitFactor * 100) / 100,
            };
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to compute insights' });
        }
    });
}
