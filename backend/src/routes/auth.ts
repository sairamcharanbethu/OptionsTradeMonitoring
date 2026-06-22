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

// OpenAPI schemas for documentation
const authBodySchema = {
    type: 'object',
    required: ['username', 'password'],
    properties: {
        username: { type: 'string', minLength: 3, description: 'Username (min 3 characters)' },
        password: { type: 'string', minLength: 6, description: 'Password (min 6 characters)' }
    }
};

const authResponseSchema = {
    type: 'object',
    properties: {
        token: { type: 'string', description: 'JWT authentication token' },
        user: {
            type: 'object',
            properties: {
                id: { type: 'integer' },
                username: { type: 'string' },
                role: { type: 'string', enum: ['USER', 'ADMIN'] }
            }
        }
    }
};

const errorSchema = {
    type: 'object',
    properties: {
        error: { type: 'string' }
    }
};

const AUTH_QUERY_TIMEOUT_MS = Number(process.env.AUTH_QUERY_TIMEOUT_MS || 5000);

async function authQuery(fastify: FastifyInstance, label: string, text: string, values: any[]) {
    const startedAt = Date.now();
    try {
        const result = await fastify.pg.query({
            text,
            values,
            query_timeout: AUTH_QUERY_TIMEOUT_MS
        } as any);
        fastify.log.info(`[Auth] ${label} completed in ${Date.now() - startedAt}ms`);
        return result;
    } catch (err: any) {
        fastify.log.error({ err }, `[Auth] ${label} failed after ${Date.now() - startedAt}ms`);
        throw err;
    }
}

export default async function authRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
    fastify.post('/signup', {
        schema: {
            tags: ['Auth'],
            summary: 'Create a new user account',
            description: 'Register a new user with username and password. Returns a JWT token upon successful registration.',
            body: authBodySchema,
            response: {
                200: authResponseSchema,
                400: errorSchema,
                503: errorSchema
            }
        }
    }, async (request, reply) => {
        const startedAt = Date.now();
        try {
            let { username, password } = AuthSchema.parse(request.body);
            username = username.toLowerCase();

            const { rows } = await authQuery(
                fastify,
                'signup user existence lookup',
                'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
                [username]
            );

            if (rows.length > 0) {
                return reply.status(400).send({ error: 'Username already exists' });
            }

            const hashStartedAt = Date.now();
            const passwordHash = await bcrypt.hash(password, 10);
            fastify.log.info(`[Auth] signup password hash completed in ${Date.now() - hashStartedAt}ms`);

            const { rows: newUser } = await authQuery(
                fastify,
                'signup user insert',
                'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, role',
                [username, passwordHash]
            );

            const token = fastify.jwt.sign({
                id: newUser[0].id,
                username: newUser[0].username,
                role: newUser[0].role
            });
            fastify.log.info(`[Auth] signup completed in ${Date.now() - startedAt}ms`);
            return { token, user: newUser[0] };
        } catch (err: any) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Username and password are required' });
            }
            fastify.log.error({ err }, `[Auth] signup failed after ${Date.now() - startedAt}ms`);
            return reply.code(503).send({ error: 'Authentication service temporarily unavailable' });
        }
    });

    fastify.post('/signin', {
        schema: {
            tags: ['Auth'],
            summary: 'Sign in to get JWT token',
            description: 'Authenticate with username and password. Returns a JWT token to use for protected endpoints.',
            body: authBodySchema,
            response: {
                200: authResponseSchema,
                400: errorSchema,
                401: errorSchema,
                503: errorSchema
            }
        }
    }, async (request, reply) => {
        const startedAt = Date.now();
        try {
            let { username, password } = AuthSchema.parse(request.body);
            username = username.toLowerCase();

            const { rows } = await authQuery(
                fastify,
                'signin user lookup',
                'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
                [username]
            );

            if (rows.length === 0) {
                fastify.log.info(`[Auth] signin rejected unknown user in ${Date.now() - startedAt}ms`);
                return reply.status(401).send({ error: 'Invalid username or password' });
            }

            const user = rows[0];
            const compareStartedAt = Date.now();
            const isPasswordValid = await bcrypt.compare(password, user.password_hash);
            fastify.log.info(`[Auth] signin bcrypt compare completed in ${Date.now() - compareStartedAt}ms`);

            if (!isPasswordValid) {
                fastify.log.info(`[Auth] signin rejected invalid password in ${Date.now() - startedAt}ms`);
                return reply.status(401).send({ error: 'Invalid username or password' });
            }

            const token = fastify.jwt.sign({
                id: user.id,
                username: user.username,
                role: user.role
            });
            fastify.log.info(`[Auth] signin completed in ${Date.now() - startedAt}ms`);
            return { token, user: { id: user.id, username: user.username, role: user.role } };
        } catch (err: any) {
            if (err instanceof z.ZodError) {
                return reply.code(400).send({ error: 'Username and password are required' });
            }
            fastify.log.error({ err }, `[Auth] signin failed after ${Date.now() - startedAt}ms`);
            return reply.code(503).send({ error: 'Authentication service temporarily unavailable' });
        }
    });

    fastify.post('/change-password', {
        onRequest: [fastify.authenticate],
        schema: {
            tags: ['Auth'],
            summary: 'Change password',
            description: 'Change the current user\'s password. Requires authentication.',
            security: [{ bearerAuth: [] }],
            body: {
                type: 'object',
                required: ['currentPassword', 'newPassword'],
                properties: {
                    currentPassword: { type: 'string', minLength: 6 },
                    newPassword: { type: 'string', minLength: 6 }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        status: { type: 'string' },
                        message: { type: 'string' }
                    }
                },
                400: errorSchema,
                404: errorSchema,
                500: errorSchema
            }
        }
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
        onRequest: [fastify.authenticate],
        schema: {
            tags: ['Auth'],
            summary: 'Update username',
            description: 'Update the current user\'s username. Returns a new JWT token with updated claims.',
            security: [{ bearerAuth: [] }],
            body: {
                type: 'object',
                required: ['username'],
                properties: {
                    username: { type: 'string', minLength: 3 }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        status: { type: 'string' },
                        token: { type: 'string' },
                        user: {
                            type: 'object',
                            properties: {
                                id: { type: 'integer' },
                                username: { type: 'string' },
                                role: { type: 'string' }
                            }
                        }
                    }
                },
                400: errorSchema,
                404: errorSchema,
                500: errorSchema
            }
        }
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
        onRequest: [fastify.authenticate],
        schema: {
            tags: ['Auth'],
            summary: 'Get current user',
            description: 'Returns the authenticated user\'s information from the JWT token.',
            security: [{ bearerAuth: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        id: { type: 'integer' },
                        username: { type: 'string' },
                        role: { type: 'string', enum: ['USER', 'ADMIN'] }
                    }
                }
            }
        }
    }, async (request, reply) => {
        return (request as any).user;
    });
}
