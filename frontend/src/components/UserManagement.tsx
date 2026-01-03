import React, { useState, useEffect } from 'react';
import { api, User } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Shield, ShieldAlert, User as UserIcon, Loader2, RefreshCw, AlertCircle, Trash2, Key } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function UserManagement() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [updating, setUpdating] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const loadUsers = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await api.getAllUsers();
            setUsers(data);
        } catch (err: any) {
            setError('Failed to fetch users');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadUsers();
    }, []);

    const toggleRole = async (user: User) => {
        const newRole = user.role === 'ADMIN' ? 'USER' : 'ADMIN';
        setUpdating(user.id);
        setError(null);
        setSuccess(null);
        try {
            await api.updateUserRole(user.id, newRole);
            setSuccess(`User ${user.username} is now a ${newRole}`);
            await loadUsers();
        } catch (err: any) {
            setError(err.message || 'Failed to update role');
        } finally {
            setUpdating(null);
        }
    };

    const handleDelete = async (user: User) => {
        if (!confirm(`Are you sure you want to delete user "${user.username}"? This action cannot be undone.`)) {
            return;
        }

        setUpdating(user.id);
        setError(null);
        setSuccess(null);
        try {
            await api.deleteUser(user.id);
            setSuccess(`User ${user.username} has been deleted`);
            await loadUsers();
        } catch (err: any) {
            setError(err.message || 'Failed to delete user');
        } finally {
            setUpdating(null);
        }
    };

    const handleResetPassword = async (user: User) => {
        if (!confirm(`Reset password for "${user.username}" to default (password)?`)) {
            return;
        }

        setUpdating(user.id);
        setError(null);
        setSuccess(null);
        try {
            await api.resetUserPassword(user.id);
            setSuccess(`Password for ${user.username} has been reset to "password"`);
        } catch (err: any) {
            setError(err.message || 'Failed to reset password');
        } finally {
            setUpdating(null);
        }
    };

    if (loading) {
        return (
            <div className="flex h-[400px] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {error && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            {success && (
                <Alert className="border-green-500 text-green-600 dark:text-green-400">
                    <AlertTitle>Success</AlertTitle>
                    <AlertDescription>{success}</AlertDescription>
                </Alert>
            )}

            <Card className="border-muted-foreground/10 shadow-lg">
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                    <div>
                        <CardTitle className="text-2xl font-bold">User Management</CardTitle>
                        <CardDescription>View and manage permissions for all platform users</CardDescription>
                    </div>
                    <Button variant="outline" size="icon" onClick={loadUsers} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    </Button>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>User</TableHead>
                                <TableHead>Role</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {users.map((user) => (
                                <TableRow key={user.id}>
                                    <TableCell>
                                        <div className="flex items-center gap-3">
                                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                                                <UserIcon className="h-4 w-4 text-muted-foreground" />
                                            </div>
                                            <span className="font-medium">{user.username}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant={user.role === 'ADMIN' ? 'default' : 'secondary'} className="gap-1">
                                            {user.role === 'ADMIN' ? (
                                                <Shield className="h-3 w-3" />
                                            ) : (
                                                <UserIcon className="h-3 w-3" />
                                            )}
                                            {user.role}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {new Date((user as any).created_at).toLocaleDateString()}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end gap-1">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="gap-2"
                                                onClick={() => toggleRole(user)}
                                                disabled={updating === user.id}
                                            >
                                                {updating === user.id ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : user.role === 'ADMIN' ? (
                                                    <>
                                                        <ShieldAlert className="h-4 w-4" />
                                                        Demote
                                                    </>
                                                ) : (
                                                    <>
                                                        <Shield className="h-4 w-4" />
                                                        Promote
                                                    </>
                                                )}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 text-orange-500 hover:text-orange-600"
                                                onClick={() => handleResetPassword(user)}
                                                disabled={updating === user.id}
                                                title="Reset password to 'password'"
                                            >
                                                <Key className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 text-red-500 hover:text-red-600"
                                                onClick={() => handleDelete(user)}
                                                disabled={updating === user.id}
                                                title="Delete user"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}
