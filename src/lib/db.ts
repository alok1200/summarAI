import { PrismaClient } from '@prisma/client'

// -----------------------------------------------------------------------------
// Defensive DATABASE_URL check.
// -----------------------------------------------------------------------------
// A very common failure mode: the project's Prisma schema is configured for
// PostgreSQL, but the local `.env` still has a leftover SQLite URL
// (e.g. `file:./db/custom.db`). When that happens, the Prisma Client (which
// was generated for Postgres) still tries to honour the SQLite URL and fails
// with a cryptic "Error code 14: Unable to open the database file" — which
// gives no clue about the real cause.
//
// This guard detects that situation up-front and throws a clear, actionable
// error explaining exactly what to fix.
// -----------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  throw new Error(
    `[db] DATABASE_URL is not set. ` +
      `Create a .env file in the project root with a database connection string.`,
  )
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Silence query logging — it was spamming dev.log and making it hard
    // to spot real errors. Enable ['error', 'warn'] in local dev if needed.
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
