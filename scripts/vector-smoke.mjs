// End-to-end smoke test: load a transcript, embed it, query it via vector search.
import { PrismaClient } from "@prisma/client";
import { embedText, embedBatch, embeddingToBuffer, bufferToEmbedding } from "../src/lib/embeddings.ts";
import { retrieveRelevantChunks, cosineSimilarity } from "../src/lib/vector-search.ts";

const db = new PrismaClient();

const USER_ID = "vector-smoke-test-user";
const VIDEO_ID = "smokevid123";

try {
  // Cleanup if exists
  await db.transcript.deleteMany({ where: { userId: USER_ID, videoId: VIDEO_ID } }).catch(() => {});

  // Create a fake user row
  let user = await db.user.findUnique({ where: { id: USER_ID } });
  if (!user) {
    user = await db.user.create({
      data: { id: USER_ID, email: "vector-smoke@test.local", name: "Vector Smoke Test" }
    });
  }

  // 1. Embed three distinct chunks
  const chunks = [
    "The mitochondria is the powerhouse of the cell — it generates ATP via oxidative phosphorylation.",
    "Python lists are mutable ordered sequences; tuples are immutable. Both support indexing and slicing.",
    "In 1969, Apollo 11 landed humans on the moon. Neil Armstrong took the first step on July 20th.",
  ];
  console.log("Embedding 3 chunks...");
  const embeddings = await embedBatch(chunks);
  console.log(`Got ${embeddings.filter(Boolean).length}/3 embeddings, dim=${embeddings[0]?.length}`);

  // 2. Persist transcript + chunks with embeddings
  const transcript = await db.transcript.create({
    data: {
      userId: USER_ID,
      videoId: VIDEO_ID,
      title: "Smoke Test Video",
      lengthChars: chunks.reduce((a, b) => a + b.length, 0),
      chunkCount: chunks.length,
      embedded: true,
      chunks: {
        create: chunks.map((text, i) => ({
          chunkIndex: i,
          text,
          embedding: embeddings[i] ? Buffer.from(embeddingToBuffer(embeddings[i])) : null,
        })),
      },
    },
  });
  console.log(`Created transcript ${transcript.id}`);

  // 3. Query: "What is ATP?" should rank the mitochondria chunk first
  const q1 = await embedText("What is ATP?");
  if (!q1) throw new Error("Query embedding failed");
  const r1 = await retrieveRelevantChunks(transcript.id, q1, 2);
  console.log(`Query 'What is ATP?' → top result: chunk ${r1[0]?.chunkIndex} (score=${r1[0]?.score?.toFixed(3)})`);
  if (r1[0]?.chunkIndex !== 0) throw new Error("Expected chunk 0 (mitochondria) to rank first");

  // 4. Query: "moon landing" should rank the Apollo chunk first
  const q2 = await embedText("When did humans land on the moon?");
  const r2 = await retrieveRelevantChunks(transcript.id, q2, 2);
  console.log(`Query 'moon landing' → top result: chunk ${r2[0]?.chunkIndex} (score=${r2[0]?.score?.toFixed(3)})`);
  if (r2[0]?.chunkIndex !== 2) throw new Error("Expected chunk 2 (Apollo) to rank first");

  // 5. Cleanup
  await db.transcript.delete({ where: { id: transcript.id } });
  console.log("✅ Vector search smoke test PASSED");
} catch (e) {
  console.error("❌ Smoke test FAILED:", e.message);
  process.exit(1);
} finally {
  await db.$disconnect();
}
