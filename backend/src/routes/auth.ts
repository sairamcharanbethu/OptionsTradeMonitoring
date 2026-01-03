import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';

const AuthSchema = z.object({
    username: z.string().min(3),
    password: z.string().min(6),
});

const ChangePasswordSchema = z.object({
    currentPassword: z.string().min(6),
    newPassword: z.string().min(6),
});

export default async function authRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
    fastify.post('/signup', async (request, reply) => {
        let { username, password } = AuthSchema.parse(request.body);
        username = username.toLowerCase();

        const { rows } = await fastify.pg.query(
            'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );

        if (rows.length > 0) {
            return reply.status(400).send({ error: 'Username already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const { rows: newUser } = await fastify.pg.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, role',
            [username, passwordHash]
        );

        const token = fastify.jwt.sign({
            id: newUser[0].id,
            username: newUser[0].username,
            role: newUser[0].role
        });
        return { token, user: newUser[0] };
    });

    fastify.post('/signin', async (request, reply) => {
        let { username, password } = AuthSchema.parse(request.body);
        username = username.toLowerCase();

        const { rows } = await fastify.pg.query(
            'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );

        if (rows.length === 0) {
            return reply.status(401).send({ error: 'Invalid username or password' });
        }

        const user = rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) {
            return reply.status(401).send({ error: 'Invalid username or password' });
        }

        const token = fastify.jwt.sign({
            id: user.id,
            username: user.username,
            role: user.role
        });
        return { token, user: { id: user.id, username: user.username, role: user.role } };
    });

    fastify.post('/change-password', {
        onRequest: [fastify.authenticate]
    }, async (request, reply) => {
        const { currentPassword, newPassword } = ChangePasswordSchema.parse(request.body);
        const { id } = (request as any).user;

        try {
            const { rows } = await fastify.pg.query(
                'SELECT password_hash FROM users WHERE id = $1',
                [id]
            );

            if (rows.length === 0) {
                return reply.code(404).send({ error: 'User not found' });
            }

            const user = rows[0];
            const isPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);

            if (!isPasswordValid) {
                return reply.code(400).send({ error: 'Current password is incorrect' });
            }

            const newPasswordHash = await bcrypt.hash(newPassword, 10);
            await fastify.pg.query(
                'UPDATE users SET password_hash = $1 WHERE id = $2',
                [newPasswordHash, id]
            );

            return { status: 'ok', message: 'Password updated successfully' };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to update password' });
        }
    });

    fastify.post('/update-profile', {
        onRequest: [fastify.authenticate]
    }, async (request, reply) => {
        const { username } = z.object({ username: z.string().min(3) }).parse(request.body);
        const { id, role } = (request as any).user;
        const lowerUsername = username.toLowerCase();

        try {
            // Check if username is already taken (by someone else)
            const { rows } = await fastify.pg.query(
                'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2',
                [lowerUsername, id]
            );

            if (rows.length > 0) {
                return reply.status(400).send({ error: 'Username already exists' });
            }

            const { rows: updatedUser } = await fastify.pg.query(
                'UPDATE users SET username = $1 WHERE id = $2 RETURNING id, username, role',
                [username, id]
            );

            if (updatedUser.length === 0) {
                return reply.code(404).send({ error: 'User not found' });
            }

            // Issue new token with updated username
            const newToken = fastify.jwt.sign({
                id: updatedUser[0].id,
                username: updatedUser[0].username,
                role: updatedUser[0].role
            });

            return { status: 'ok', token: newToken, user: updatedUser[0] };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to update username' });
        }
    });

    fastify.get('/me', {
        onRequest: [fastify.authenticate]
    }, async (request, reply) => {
        return (request as any).user;
    });
}
