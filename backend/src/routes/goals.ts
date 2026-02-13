import { FastifyInstance } from 'fastify';

export async function goalRoutes(fastify: FastifyInstance) {
    fastify.addHook('onRequest', fastify.authenticate);

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
         VALUES ($1, $2, $3, $4) RETURNING *`,
                [goalId, entry_date, amount, notes || null]
            );
            return reply.code(201).send(rows[0]);
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.code(409).send({ error: 'An entry already exists for this date. Update it instead.' });
            }
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

            const now = new Date();
            const startDate = new Date(goal.start_date);
            const endDate = new Date(goal.end_date);

            const msPerDay = 1000 * 60 * 60 * 24;
            const daysTotal = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / msPerDay));
            const daysElapsed = Math.max(1, Math.ceil((Math.min(now.getTime(), endDate.getTime()) - startDate.getTime()) / msPerDay));
            const daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / msPerDay));

            const percentComplete = Math.min(100, (totalEarned / targetAmount) * 100);
            const dailyAverage = totalEarned / daysElapsed;
            const projectedTotal = dailyAverage * daysTotal;
            const remainingPerDay = daysRemaining > 0 ? (targetAmount - totalEarned) / daysRemaining : 0;

            // Expected progress at this point (linear)
            const expectedPercent = (daysElapsed / daysTotal) * 100;
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
            };
        } catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to compute insights' });
        }
    });
}
