import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
try {
  const tables = await db.$queryRaw`SELECT name FROM sqlite_master WHERE type='table'`;
  console.log("Tables:", tables.map(t => t.name).join(", "));
  const t = await db.transcript.count();
  const c = await db.transcriptChunk.count();
  const u = await db.user.count();
  console.log(`Users: ${u}, Transcripts: ${t}, Chunks: ${c}`);
} catch (e) {
  console.error("Error:", e.message);
  process.exit(1);
} finally {
  await db.$disconnect();
}
