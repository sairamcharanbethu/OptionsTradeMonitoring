import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';

const AuthSchema = z.object({
    username: z.string().min(3),
    password: z.string().min(6),
});

export default async function authRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
    fastify.post('/signup', async (request, reply) => {
        const { username, password } = AuthSchema.parse(request.body);

        const { rows } = await fastify.pg.query(
            'SELECT id FROM users WHERE username = $1',
            [username]
        );

        if (rows.length > 0) {
            return reply.status(400).send({ error: 'Username already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const { rows: newUser } = await fastify.pg.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
            [username, passwordHash]
        );

        const token = fastify.jwt.sign({ id: newUser[0].id, username: newUser[0].username });
        return { token, user: newUser[0] };
    });

    fastify.post('/signin', async (request, reply) => {
        const { username, password } = AuthSchema.parse(request.body);

        const { rows } = await fastify.pg.query(
            'SELECT * FROM users WHERE username = $1',
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

        const token = fastify.jwt.sign({ id: user.id, username: user.username });
        return { token, user: { id: user.id, username: user.username } };
    });

    fastify.get('/me', {
        onRequest: [fastify.authenticate]
    }, async (request, reply) => {
        return (request as any).user;
    });
}
