import { FastifyInstance } from 'fastify';

// ─── US Trading-Day Helpers ───
// Returns true if a date is a US market holiday (NYSE observed calendar).
function getUSMarketHolidays(year: number): Set<string> {
    const holidays = new Set<string>();

    const add = (m: number, d: number) => {
        let dt = new Date(year, m - 1, d);
        // If Saturday, observe Friday; if Sunday, observe Monday
        if (dt.getDay() === 6) dt = new Date(year, m - 1, d - 1);
        if (dt.getDay() === 0) dt = new Date(year, m - 1, d + 1);
        holidays.add(dt.toISOString().split('T')[0]);
    };

    // Fixed-date holidays
    add(1, 1);   // New Year's Day
    add(6, 19);  // Juneteenth
    add(7, 4);   // Independence Day
    add(12, 25); // Christmas Day

    // Nth-weekday holidays
    const nthWeekday = (month: number, weekday: number, n: number): Date => {
        const first = new Date(year, month - 1, 1);
        let day = 1 + ((weekday - first.getDay() + 7) % 7);
        day += (n - 1) * 7;
        return new Date(year, month - 1, day);
    };

    // Last weekday of month
    const lastWeekday = (month: number, weekday: number): Date => {
        const last = new Date(year, month, 0); // last day of month
        let day = last.getDate() - ((last.getDay() - weekday + 7) % 7);
        return new Date(year, month - 1, day);
    };

    // MLK Day: 3rd Monday of January
    const mlk = nthWeekday(1, 1, 3);
    holidays.add(mlk.toISOString().split('T')[0]);

    // Presidents' Day: 3rd Monday of February
    const pres = nthWeekday(2, 1, 3);
    holidays.add(pres.toISOString().split('T')[0]);

    // Memorial Day: Last Monday of May
    const mem = lastWeekday(5, 1);
    holidays.add(mem.toISOString().split('T')[0]);

    // Labor Day: 1st Monday of September
    const labor = nthWeekday(9, 1, 1);
    holidays.add(labor.toISOString().split('T')[0]);

    // Thanksgiving: 4th Thursday of November
    const thanks = nthWeekday(11, 4, 4);
    holidays.add(thanks.toISOString().split('T')[0]);

    // Good Friday: 2 days before Easter Sunday
    const easterSunday = computeEaster(year);
    const goodFriday = new Date(easterSunday);
    goodFriday.setDate(goodFriday.getDate() - 2);
    holidays.add(goodFriday.toISOString().split('T')[0]);

    return holidays;
}

// Anonymous Gregorian Easter (Meeus algorithm)
function computeEaster(year: number): Date {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
}

// Count trading days between two dates (inclusive of start, exclusive of end)
function tradingDaysBetween(from: Date, to: Date): number {
    if (to <= from) return 0;

    // Collect holidays for all years in range
    const holidays = new Set<string>();
    for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
        getUSMarketHolidays(y).forEach(h => holidays.add(h));
    }

    let count = 0;
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(0, 0, 0, 0);

    while (cursor < end) {
        const dow = cursor.getDay();
        if (dow !== 0 && dow !== 6) {
            const key = cursor.toISOString().split('T')[0];
            if (!holidays.has(key)) count++;
        }
        cursor.setDate(cursor.getDate() + 1);
    }
    return count;
}

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

            // Use US trading days instead of calendar days
            const daysTotal = Math.max(1, tradingDaysBetween(startDate, endDate));
            const effectiveNow = now < endDate ? now : endDate;
            const daysElapsed = Math.max(1, tradingDaysBetween(startDate, effectiveNow));
            const daysRemaining = Math.max(0, tradingDaysBetween(now, endDate));

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
