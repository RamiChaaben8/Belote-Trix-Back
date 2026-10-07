// ============================================================
// SEED DISABLED — guest-only build.
//
// The demo user accounts (Alice / Bob / Carol / Dave) are no longer
// used: there is no registration, login or profile system. The
// original seeder is preserved below.
// ============================================================
// import { PrismaClient } from "@prisma/client";
// import bcrypt from "bcryptjs";
//
// const prisma = new PrismaClient();
//
// async function main() {
//   const passwordHash = await bcrypt.hash("password123", 10);
//   const users = [
//     { name: "Alice", email: "alice@example.com", avatar: "🦊", gamesPlayed: 12, gamesWon: 7, totalScore: 2840 },
//     { name: "Bob", email: "bob@example.com", avatar: "🐻", gamesPlayed: 10, gamesWon: 4, totalScore: 1960 },
//     { name: "Carol", email: "carol@example.com", avatar: "🐼", gamesPlayed: 8, gamesWon: 5, totalScore: 2210 },
//     { name: "Dave", email: "dave@example.com", avatar: "🦁", gamesPlayed: 6, gamesWon: 1, totalScore: 870 },
//   ];
//   for (const u of users) {
//     await prisma.user.upsert({ where: { email: u.email }, update: {}, create: { ...u, passwordHash } });
//   }
//   console.log("Seeded demo users (password: password123)");
// }
//
// main()
//   .catch((e) => {
//     console.error(e);
//     process.exit(1);
//   })
//   .finally(() => prisma.$disconnect());

console.log("Seed skipped: the guest-only build has no user accounts.");
