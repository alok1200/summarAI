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
      `Create a .env file in the project root with a Postgres connection string, e.g.\n` +
      `  DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DBNAME?sslmode=require"\n` +
      `See .env.example for the full template.`,
  )
}

if (DATABASE_URL.startsWith('file:')) {
  throw new Error(
    `[db] DATABASE_URL is a SQLite path ("${DATABASE_URL}"), but the Prisma schema ` +
      `is configured for PostgreSQL. This is why you see "Error code 14: Unable to open the database file".\n\n` +
      `FIX:\n` +
      `  1. Open .env in the project root.\n` +
      `  2. Replace the file:... line with a Postgres URL, e.g.\n` +
      `       DATABASE_URL="postgresql://neondb_owner:npg_xxx@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require"\n` +
      `  3. Run: npx prisma generate && npx prisma db push\n` +
      `  4. Restart the dev server (npm run dev).\n` +
      `See .env.example for a free Neon Postgres setup walkthrough.`,
  )
}

if (!DATABASE_URL.startsWith('postgres')) {
  // Not strictly fatal, but warn loudly — most non-postgres URLs in this project
  // are the result of a copy/paste mistake.
  console.warn(
    `[db] Warning: DATABASE_URL does not look like a Postgres URL ` +
      `(got: "${DATABASE_URL.slice(0, 40)}..."). The Prisma schema expects PostgreSQL.`,
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
