import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';

const UpdateRoleSchema = z.object({
    role: z.enum(['USER', 'ADMIN']),
});

export async function adminRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
    // Admin only middleware for this plugin
    fastify.addHook('onRequest', async (request, reply) => {
        try {
            await request.jwtVerify();
            const { role } = (request as any).user;
            if (role !== 'ADMIN') {
                return reply.code(403).send({ error: 'Admin access required' });
            }
        } catch (err) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
    });

    // GET /api/admin/users - List all users
    fastify.get('/users', async (request, reply) => {
        try {
            const { rows } = await fastify.pg.query(
                `SELECT id, username, role, created_at FROM users ORDER BY created_at DESC`
            );
            return rows;
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch users' });
        }
    });

    // POST /api/admin/users/:id/role - Update user role
    fastify.post('/users/:id/role', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { role } = UpdateRoleSchema.parse(request.body);

        try {
            const { rowCount } = await fastify.pg.query(
                'UPDATE users SET role = $1 WHERE id = $2',
                [role, id]
            );

            if (rowCount === 0) {
                return reply.code(404).send({ error: 'User not found' });
            }

            return { status: 'ok', message: `User role updated to ${role}` };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to update user role' });
        }
    });

    // DELETE /api/admin/users/:id - Delete a user
    fastify.delete('/users/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const currentUser = (request as any).user;

        try {
            // Prevent self-deletion
            if (parseInt(id) === currentUser.id) {
                return reply.code(400).send({ error: 'Cannot delete your own account' });
            }

            const { rowCount } = await fastify.pg.query(
                'DELETE FROM users WHERE id = $1',
                [id]
            );

            if (rowCount === 0) {
                return reply.code(404).send({ error: 'User not found' });
            }

            return { status: 'ok', message: 'User deleted successfully' };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to delete user' });
        }
    });

    // POST /api/admin/users/:id/reset-password - Reset user password
    fastify.post('/users/:id/reset-password', async (request, reply) => {
        const { id } = request.params as { id: string };
        const defaultPassword = 'password';

        try {
            const passwordHash = await bcrypt.hash(defaultPassword, 10);

            const { rowCount } = await fastify.pg.query(
                'UPDATE users SET password_hash = $1 WHERE id = $2',
                [passwordHash, id]
            );

            if (rowCount === 0) {
                return reply.code(404).send({ error: 'User not found' });
            }

            return { status: 'ok', message: 'Password reset to default' };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to reset password' });
        }
    });
}
