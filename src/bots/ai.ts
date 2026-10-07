import { Card, Deck, strengthOf } from "@/game-engine/card";
import { FIFTY_ONE_TARGET, FiftyOneMode, ModeManager } from "@/game-engine/modes";
import type { RoundManager } from "@/game-engine/round";
import { TrickEngine } from "@/game-engine/rules";
import { CardData, Difficulty, ModeId, Move, Suit } from "@/types";

type Rng = () => number;

function pick<T>(arr: T[], rng: Rng): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Cards that this seat has not seen: not in own hand and not yet played. */
export function unseenCards(round: RoundManager, seat: number): Card[] {
  const known = new Set<string>();
  for (const c of round.hands[seat]) known.add(c.id);
  for (const p of round.plays) known.add(new Card(p.card.suit, p.card.rank).id);
  return Deck.all().filter((c) => !known.has(c.id));
}

export function chooseMove(round: RoundManager, seat: number, difficulty: Difficulty, rng: Rng = Math.random): Move {
  const legal = round.legalMoves(seat);
  // Trix: a player with no legal moves must pass — return a sentinel that round.play() handles
  if (round.isTrix && legal.length === 0) {
    return { card: { suit: "C", rank: "7" } }; // sentinel: round.play() sees 0 legal moves → applyTrixPass
  }
  if (legal.length === 0) throw new Error("No legal moves");
  if (legal.length === 1) return legal[0];
  if (difficulty === "easy") return pick(legal, rng);
  if (round.isFifty) return chooseFifty(round, seat, legal, difficulty, rng);
  if (round.isTrix) return chooseTrix(round, seat, legal, difficulty, rng);
  return chooseTrick(round, seat, legal, difficulty, rng);
}

function chooseFifty(round: RoundManager, seat: number, legal: Move[], difficulty: Difficulty, rng: Rng): Move {
  const winning = legal.find((m) => round.total + FiftyOneMode.delta(m) === FIFTY_ONE_TARGET);
  if (winning) return winning;
  if (difficulty === "medium") return pick(legal, rng);

  const unseen = unseenCards(round, seat);
  let best = legal[0];
  let bestScore = -Infinity;
  for (const m of legal) {
    const newTotal = FiftyOneMode.next(round.total, m);
    const remaining = round.hands[seat].filter((c) => !c.equals(m.card));
    let myHits = 0;
    for (const c of remaining) {
      const options: Move[] = c.rank === "A" ? [{ card: c.toJSON(), aceValue: 1 }, { card: c.toJSON(), aceValue: 11 }] : [{ card: c.toJSON() }];
      if (options.some((o) => newTotal + FiftyOneMode.delta(o) === FIFTY_ONE_TARGET)) myHits++;
    }
    let danger = 0;
    for (const c of unseen) {
      const options: Move[] = c.rank === "A" ? [{ card: c.toJSON(), aceValue: 1 }, { card: c.toJSON(), aceValue: 11 }] : [{ card: c.toJSON() }];
      if (options.some((o) => newTotal + FiftyOneMode.delta(o) === FIFTY_ONE_TARGET)) danger++;
    }
    const dangerRate = danger / Math.max(1, unseen.length);
    // Setting up a 51 for ourselves is good only if opponents are unlikely to snatch it first.
    const score = myHits * 3 * (1 - dangerRate * 2) - danger * 2 + (m.card.rank === "J" ? 0.3 : 0) + rng() * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function chooseTrix(round: RoundManager, seat: number, legal: Move[], difficulty: Difficulty, rng: Rng): Move {
  // Medium: prefer cards that extend chains (opens new options for self next turn)
  // Hard: additionally prefer cards that lead towards completing a suit fastest
  if (difficulty === "medium") {
    // Play the card that opens the most new chain positions for any player
    // Simple proxy: prefer opening new suits (J plays) or extending long chains
    const table = round.trix!.table;
    let best = legal[0];
    let bestScore = -Infinity;
    for (const m of legal) {
      const suit = m.card.suit as "H" | "D" | "C" | "S";
      const range = table[suit];
      let score = 0;
      if (range === null) {
        // Opening a new suit is generally valuable (J play)
        score += 2;
      } else {
        // Prefer extending suits that have more room to grow
        const low = range.low;
        const high = range.high;
        score += (low) + (7 - high); // more room = higher score
      }
      score += rng() * 0.5;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }
  // Hard: prefer the card in our hand that best unblocks our own remaining cards
  const hand = round.hands[seat];
  const table = round.trix!.table;
  let best = legal[0];
  let bestScore = -Infinity;
  for (const m of legal) {
    const suit = m.card.suit as "H" | "D" | "C" | "S";
    const rankOrder = ["7","8","9","10","J","Q","K","A"];
    const idx = rankOrder.indexOf(m.card.rank);
    const range = table[suit];
    let score = 0;
    // Count how many of our own cards in this suit become playable after this play
    const myInSuit = hand.filter((c) => c.suit === suit && c.id !== `${m.card.rank}${suit}`);
    for (const c of myInSuit) {
      const ci = rankOrder.indexOf(c.rank);
      if (range === null) {
        if (ci === idx - 1 || ci === idx + 1) score += 3;
      } else {
        const newLow = Math.min(range.low, idx);
        const newHigh = Math.max(range.high, idx);
        if (ci === newLow - 1 || ci === newHigh + 1) score += 3;
      }
    }
    // Bias towards emptying suits we're close to clearing
    const remaining = myInSuit.length + 1; // +1 for the card being played
    score += (8 - remaining) * 0.5;
    score += rng() * 0.1;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best;
}

function chooseTrick(round: RoundManager, seat: number, legal: Move[], difficulty: Difficulty, rng: Rng): Move {
  const mode = ModeManager.trick(round.mode);
  const trick = round.trick;
  const led: Suit | null = TrickEngine.leadSuit(trick);
  const unseen = difficulty === "hard" ? unseenCards(round, seat) : [];
  const voids = difficulty === "hard" ? TrickEngine.voids([...round.completed.map((t) => t.plays), trick]) : new Map();
  const remainingAfterMe = 3 - trick.length;
  const followers: number[] = [];
  for (let i = 1; i <= remainingAfterMe; i++) followers.push((seat + i) % 4);

  const bestOnTable = trick
    .filter((p) => p.card.suit === led)
    .reduce((m, p) => Math.max(m, strengthOf(p.card.rank)), -1);

  let best = legal[0];
  let bestU = -Infinity;
  for (const m of legal) {
    const c = m.card;
    const suit = led ?? c.suit;
    const str = strengthOf(c.rank);
    const pts = mode.trickPoints([...trick.map((p) => p.card), c]);
    let pWin: number;
    if (c.suit !== suit || str < bestOnTable) {
      pWin = 0;
    } else if (difficulty === "medium") {
      pWin = remainingAfterMe === 0 ? 1 : 0.5;
    } else {
      const holders = [0, 1, 2, 3].filter((s) => s !== seat && !trick.some((p) => p.seat === s) && !voids.get(s)?.has(suit));
      const futureHolders = followers.filter((s) => !voids.get(s)?.has(suit));
      const higher = unseen.filter((u) => u.suit === suit && u.strength > str).length;
      const allHolders = [0, 1, 2, 3].filter((s) => s !== seat && !voids.get(s)?.has(suit));
      const denom = Math.max(1, allHolders.length);
      void holders;
      pWin = Math.pow(Math.max(0, 1 - futureHolders.length / denom), higher);
    }
    let u: number;
    if (mode.avoid) {
      u = -pWin * pts + 0.05 * str * (1 - pWin);
      if (mode.cardPoints(c) > 0) u += (1 - pWin) * 20; // discard the dangerous card onto someone else
    } else if (round.mode === "LastTrick") {
      // Last Trick: only the 8th trick matters.
      const tricksLeft = 8 - round.completed.length; // tricks remaining including current
      if (tricksLeft > 1) {
        // Early tricks — preserve high cards (don't win tricks; save high cards for trick 8).
        // Prefer playing the lowest card, avoid winning.
        u = -pWin * 5 - str * 0.3;
      } else {
        // Final trick — must win it! Maximise win probability.
        u = pWin * 100 - (1 - pWin) * str * 0.1;
      }
    } else {
      // Turns mode (avoid=false): want to WIN tricks, so maximise win probability.
      u = pWin * pts - (1 - pWin) * 0.5 * str - 0.02 * str;
    }
    if (difficulty === "medium") u += rng() * 0.5;
    else u += rng() * 0.001;
    if (u > bestU) {
      bestU = u;
      best = m;
    }
  }
  return best;
}

export function chooseMode(remaining: ModeId[], hand: Card[], difficulty: Difficulty, rng: Rng = Math.random): ModeId {
  if (difficulty !== "hard" || remaining.length === 1) return pick(remaining, rng);
  const queens = hand.filter((c) => c.rank === "Q").length;
  const diamonds = hand.filter((c) => c.suit === "D");
  const hasKH = hand.some((c) => c.suit === "H" && c.rank === "K");
  const low = hand.filter((c) => c.strength <= 2 || c.rank === "Q" || c.rank === "K").length;
  // High-strength cards (A, 10, K) are good for Turns and Last Trick
  const highCards = hand.filter((c) => c.strength >= 6).length;
  const value: Record<ModeId, number> = {
    Queens: queens * 3 + hand.filter((c) => c.strength >= 5).length * 0.5,
    Diamonds: diamonds.length * 1.5 + diamonds.filter((c) => c.strength >= 5).length,
    KingOfHearts: hasKH ? 2 : 3,
    Turns: highCards * 1.5 + (8 - low) * 0.5,
    // Last Trick: having at least one very high card (A or 10) is key
    LastTrick: hand.filter((c) => c.strength >= 7).length * 3 + highCards * 0.5,
    // Trix: value hands with long consecutive runs in any suit (easier to empty)
    Trix: (() => {
      let score = 0;
      for (const suit of ["H","D","C","S"] as const) {
        const inSuit = hand.filter((c) => c.suit === suit);
        // Having J in a suit is extra valuable (opens it)
        if (inSuit.some((c) => c.rank === "J")) score += 2;
        score += inSuit.length * 0.5;
      }
      return score;
    })(),
    General: highCards * 1.2 + diamonds.length * 0.8 + queens * 0.8 + (hasKH ? 2 : 0),
    FiftyOne: low * 0.8,
    // Switch/Star: bots avoid picking these directly (handled via autoAct in room.ts)
    Switch: 0,
    Star: 0,
  };
  // Filter out Switch and Star from bot value-based selection (bots handle them via autoAct)
  const eligible = remaining.filter((m) => m !== "Switch" && m !== "Star");
  const pool = eligible.length > 0 ? eligible : remaining;
  return [...pool].sort((a, b) => value[b] + rng() * 0.5 - (value[a] + rng() * 0.5))[0];
}

export type { CardData };
