// ============================================================
// PERSISTENCE DISABLED — guest-only, session-only build.
//
// Nothing is written to the database any more: no accounts, no
// statistics, no permanent match history. A match exists only while
// the room is alive, and saveGame() reports "nothing saved" so the
// post-match Replay button never appears.
//
// The original implementation is preserved below — remove the block
// comment markers to restore database storage (Games, Players,
// Rounds, Tricks, Scores, Bots) together with the Prisma schema.
// ============================================================
/*
import { prisma } from "@/lib/prisma";
import type { GameRoom } from "@/game-engine/room";
import { BotPlayer } from "@/game-engine/players";
import { ScoreManager } from "@/game-engine/score";

// Persists a finished game (rounds, tricks, cards, scores, chat) and updates user statistics.
export async function saveGame(room: GameRoom): Promise<string | null> {
  const engine = room.engine;
  if (!engine || room.saved) return null;
  room.saved = true;
  const winners = ScoreManager.winners(engine.totals);
  const game = await prisma.game.create({
    data: { code: room.code, status: "FINISHED", difficulty: room.difficulty.toUpperCase(), finishedAt: new Date() },
  });

  for (const p of engine.players) {
    const player = await prisma.player.create({
      data: {
        gameId: game.id,
        userId: p.userId,
        seat: p.seat,
        name: p.name,
        avatar: p.avatar,
        isBot: p.isBot,
        totalScore: engine.totals[p.seat],
        winner: winners.includes(p.seat),
      },
    });
    if (p instanceof BotPlayer) {
      await prisma.botPlayer.create({ data: { gameId: game.id, playerId: player.id, difficulty: p.difficulty } });
    }
    if (p.userId) {
      await prisma.user
        .update({
          where: { id: p.userId },
          data: {
            gamesPlayed: { increment: 1 },
            gamesWon: { increment: winners.includes(p.seat) ? 1 : 0 },
            totalScore: { increment: engine.totals[p.seat] },
          },
        })
        .catch(() => undefined);
    }
  }

  let running = [0, 0, 0, 0];
  for (const res of engine.results) {
    const r = res.round;
    const round = await prisma.round.create({
      data: {
        gameId: game.id,
        number: res.number,
        mode: res.mode,
        selectorSeat: res.selector,
        hands: JSON.parse(JSON.stringify(r.initialHands)),
        scores: res.scores,
      },
    });
    const trickIds = new Map<number, string>();
    for (const t of r.completed) {
      const trick = await prisma.trick.create({
        data: { roundId: round.id, number: t.index, leaderSeat: t.leader, winnerSeat: t.winner },
      });
      trickIds.set(t.index, trick.id);
    }
    await prisma.playedCard.createMany({
      data: r.plays.map((p) => ({
        roundId: round.id,
        trickId: trickIds.get(p.trickIndex) ?? null,
        seq: p.seq,
        seat: p.seat,
        suit: p.card.suit,
        rank: p.card.rank,
        meta: p.total !== undefined ? { total: p.total, aceValue: p.aceValue ?? null } : undefined,
      })),
    });
    // Keep the replay chart in sync with the live totals: apply the
    // Thousand Reset (global Rule #2) as the running score crosses ±1000.
    running = running.map((t, i) => ScoreManager.applyThousandReset(t + res.scores[i]));
    await prisma.scoreHistory.createMany({
      data: running.map((total, seat) => ({ gameId: game.id, round: res.number, seat, delta: res.scores[seat], total })),
    });
    await prisma.gameModeHistory.create({
      data: { gameId: game.id, seat: res.selector, mode: res.mode, roundNumber: res.number },
    });
  }

  if (room.chat.length) {
    await prisma.chatMessage.createMany({
      data: room.chat.map((m) => ({ gameId: game.id, roomCode: room.code, author: m.author, content: m.content, createdAt: new Date(m.at) })),
    });
  }
  return game.id;
}
*/

import type { GameRoom } from "@/game-engine/room";

/**
 * Session-only build: finished games are kept in memory for as long as
 * the room lives and are never written to the database.
 */
export async function saveGame(_room: GameRoom): Promise<string | null> {
  return null;
}
