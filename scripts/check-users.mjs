import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const users = await prisma.user.findMany({ select: { id: true, email: true, name: true, passwordHash: true } });
console.log(JSON.stringify(users.map(u => ({...u, hashLen: u.passwordHash.length})), null, 2));
await prisma.$disconnect();
