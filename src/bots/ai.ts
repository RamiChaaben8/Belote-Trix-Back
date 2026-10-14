import { Card, Deck, strengthOf } from "@/game-engine/card";
import { FIFTY_ONE_REWARD, FIFTY_ONE_TARGET, FiftyOneMode, ModeManager } from "@/game-engine/modes";
import type { RoundManager } from "@/game-engine/round";
import { TrickEngine } from "@/game-engine/rules";
import { CardData, Difficulty, ModeId, Move, Suit } from "@/types";

type Rng = () => number;

/*
 * GLOBAL AI RULE: the match winner is the player with the LOWEST total score.
 * Every evaluation below is therefore a COST (expected penalty points) that the bot
 * minimises. Bots never try to "gain" points; they try to avoid them.
 *
 *   easy   - random legal move, no tracking.
 *   medium - tracks the current trick, mode objective and recent plays (void suits seen so far).
 *   hard   - full card counting, void inference, penalty tracking, capot hunting, endgame planning.
 */

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

// ─────────────────────────────────────────────────────────────────────────────
// FIFTY ONE — avoid being the one who lands on 51; push others towards it.
// ─────────────────────────────────────────────────────────────────────────────

function fiftyOptions(c: Card | CardData): Move[] {
  const data = c instanceof Card ? c.toJSON() : c;
  return data.rank === "A"
    ? [{ card: data, aceValue: 1 }, { card: data, aceValue: 11 }]
    : [{ card: data }];
}

/** A card is "lose-only" at `total` when it can be played but every playable option reaches 51. */
function fiftyClass(c: Card | CardData, total: number): "safe" | "loseOnly" | "dead" {
  const playable = fiftyOptions(c).filter((o) => total + FiftyOneMode.delta(o) <= FIFTY_ONE_TARGET);
  if (playable.length === 0) return "dead";
  return playable.some((o) => !FiftyOneMode.isLosing(total, o)) ? "safe" : "loseOnly";
}

/** Expected penalty (lower is better) of making move `m`. */
export function fiftyMoveCost(round: RoundManager, seat: number, m: Move, difficulty: Difficulty): number {
  if (FiftyOneMode.isLosing(round.total, m)) return FIFTY_ONE_REWARD; // forced loss, only chosen if nothing else
  const newTotal = FiftyOneMode.next(round.total, m);
  const remaining = round.hands[seat].filter((c) => !c.equals(m.card));

  // Own future risk: cards that can only lose at the new total.
  let loseOnly = 0;
  for (const c of remaining) if (fiftyClass(c, newTotal) === "loseOnly") loseOnly++;
  const myRisk = remaining.length ? loseOnly / remaining.length : 0;
  let cost = FIFTY_ONE_REWARD * 0.5 * myRisk;

  // Neutral / total-lowering cards are our lifeboats: don't burn them without need.
  const r = m.card.rank;
  if (r === "9" || r === "J") cost += 12;
  else if (r === "10") cost += 8;

  if (difficulty === "hard") {
    // Card counting: how likely is the next player to be cornered into a losing move?
    const unseen = unseenCards(round, seat);
    let safe = 0;
    let lose = 0;
    for (const u of unseen) {
      const k = fiftyClass(u, newTotal);
      if (k === "safe") safe++;
      else if (k === "loseOnly") lose++;
    }
    const others = [0, 1, 2, 3].filter((s) => s !== seat);
    const avgHand = others.reduce((a, s) => a + round.hands[s].length, 0) / 3;
    const k = Math.max(1, Math.min(3, Math.round(avgHand)));
    const pForce = lose + safe === 0 ? 0 : Math.pow(lose / (lose + safe), k);
    // Pushing opponents into 51 doesn't lower my score directly, but it protects my ranking.
    cost -= FIFTY_ONE_REWARD * 0.3 * pForce;
    // Danger of an exact 51 landing spot being the next total for me: prefer totals far from 51.
    cost += Math.max(0, 6 - (FIFTY_ONE_TARGET - newTotal)) * 2;
  }
  return cost;
}

function chooseFifty(round: RoundManager, seat: number, legal: Move[], difficulty: Difficulty, rng: Rng): Move {
  let best = legal[0];
  let bestCost = Infinity;
  for (const m of legal) {
    const cost = fiftyMoveCost(round, seat, m, difficulty) + rng() * (difficulty === "hard" ? 0.01 : 4);
    if (cost < bestCost) {
      bestCost = cost;
      best = m;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIX — finish first (1st > 2nd), shed cards quickly.
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// TRICK MODES — minimise expected penalty points.
// ─────────────────────────────────────────────────────────────────────────────

const CAPOT_MODES: ModeId[] = ["Turns", "General"];

/** True while every trick so far was won by `seat` (so Capot is still possible). */
export function capotAlive(round: RoundManager, seat: number): boolean {
  return CAPOT_MODES.includes(round.mode) && round.completed.every((t) => t.winner === seat);
}

/**
 * Hard AI: estimate Capot probability from card counting. A card is a "sure winner" when no unseen
 * card of its suit is stronger; other cards win with decaying probability per stronger unseen card.
 */
export function hardCapotChance(round: RoundManager, seat: number): number {
  const hand = round.hands[seat];
  if (hand.length === 0) return 0;
  const unseen = unseenCards(round, seat);
  const voids = TrickEngine.voids([...round.completed.map((t) => t.plays), round.trick]);
  let chance = 1;
  for (const c of hand) {
    const higher = unseen.filter((u) => u.suit === c.suit && u.strength > c.strength).length;
    if (higher === 0) continue;
    // Holders still able to hold a stronger card (void players cannot).
    const holders = [0, 1, 2, 3].filter((s) => s !== seat && !voids.get(s)?.has(c.suit)).length;
    const p = holders === 0 ? 1 : Math.pow(0.45, Math.min(higher, 3));
    chance *= p;
  }
  return Math.min(0.97, chance);
}

/** Medium AI: crude Capot estimate from the strength of the cards still in hand. */
export function mediumCapotChance(round: RoundManager, seat: number): number {
  const hand = round.hands[seat];
  if (hand.length === 0) return 0;
  let chance = 1;
  for (const c of hand) chance *= c.strength >= 6 ? 0.9 : c.strength >= 5 ? 0.5 : 0.15;
  return chance;
}

/** Whether the bot should switch to a Capot-hunting strategy right now. */
export function shouldPursueCapot(round: RoundManager, seat: number, difficulty: Difficulty): boolean {
  if (difficulty === "easy" || !capotAlive(round, seat)) return false;
  const wins = round.completed.length;
  if (difficulty === "medium") return wins >= 5 && mediumCapotChance(round, seat) > 0.6;
  return wins >= 4 && hardCapotChance(round, seat) > 0.4;
}

function chooseTrick(round: RoundManager, seat: number, legal: Move[], difficulty: Difficulty, rng: Rng): Move {
  const mode = ModeManager.trick(round.mode);
  const trick = round.trick;
  const led: Suit | null = TrickEngine.leadSuit(trick);
  const hard = difficulty === "hard";
  const unseen = hard ? unseenCards(round, seat) : [];
  // Medium learns void suits from plays so far; hard uses the same plus full card counting.
  const voids = TrickEngine.voids([...round.completed.map((t) => t.plays), trick]);
  const remainingAfterMe = 3 - trick.length;
  const followers: number[] = [];
  for (let i = 1; i <= remainingAfterMe; i++) followers.push((seat + i) % 4);

  const tricksLeft = 8 - round.completed.length; // including the current one
  const isLastTrick = tricksLeft === 1;
  const pursueCapot = shouldPursueCapot(round, seat, difficulty);

  const bestOnTable = trick
    .filter((p) => p.card.suit === led)
    .reduce((m, p) => Math.max(m, strengthOf(p.card.rank)), -1);

  /** Penalty points awarded to the winner of the trick containing these cards. */
  const penaltyFor = (cards: CardData[]): number => {
    let pts = mode.trickPoints(cards);
    if ((round.mode === "LastTrick" || round.mode === "General") && isLastTrick) pts += 100;
    return pts;
  };

  let best = legal[0];
  let bestCost = Infinity;
  for (const m of legal) {
    const c = m.card;
    const suit = led ?? c.suit;
    const str = strengthOf(c.rank);
    const tableCards = [...trick.map((p) => p.card), c];
    let pts = penaltyFor(tableCards);

    // ── Probability that this card wins the trick ──
    let pWin: number;
    if (c.suit !== suit || str < bestOnTable) {
      pWin = 0;
    } else if (remainingAfterMe === 0) {
      pWin = 1;
    } else if (!hard) {
      const live = followers.filter((s) => !voids.get(s)?.has(suit));
      pWin = live.length === 0 ? 1 : Math.pow(0.5, Math.min(live.length, 2));
    } else {
      const higher = unseen.filter((u) => u.suit === suit && u.strength > str).length;
      const others = [0, 1, 2, 3].filter((s) => s !== seat && !voids.get(s)?.has(suit));
      const k = Math.max(1, others.length);
      pWin = 1;
      for (const f of followers) {
        if (voids.get(f)?.has(suit)) continue;
        const holdsHigher = 1 - Math.pow(1 - 1 / k, higher);
        pWin *= 1 - 0.6 * holdsHigher;
      }
      // If I'd win, followers may still dump penalty cards on me. Count what is likely to land.
      if (mode.avoid || round.mode === "General") {
        let extra = 0;
        for (const f of followers) {
          const fv = voids.get(f);
          const inSuit = unseen.filter((u) => u.suit === suit && !fv?.has(suit));
          for (const u of inSuit) extra += (mode.cardPoints(u.toJSON()) / k) * 0.4;
        }
        pts += extra;
      }
    }

    // ── Capot hunting: win everything ──
    if (pursueCapot) {
      const u = -pWin * 100 - 0.05 * str + rng() * (hard ? 0.001 : 0.1);
      if (u < bestCost) {
        bestCost = u;
        best = m;
      }
      continue;
    }

    // ── Expected penalty for this move ──
    let cost = pWin * pts;

    // Dumping a penalty card onto somebody else removes future risk for me.
    const cardPts = mode.cardPoints(c);
    if (cardPts > 0) cost -= Math.pow(1 - pWin, 3) * cardPts * (hard ? 0.6 : 0.4);

    // Preserve low cards for later / shed dangerous high cards early when it is safe to do so.
    cost -= (1 - pWin) * 0.05 * str;

    if (round.mode === "LastTrick" || round.mode === "General") {
      if (!isLastTrick) {
        // Endgame planning: whatever I hold at trick 8 is what could win it; shed high cards now.
        const rest = round.hands[seat].filter((x) => !x.equals(c));
        if (rest.length) {
          const avg = rest.reduce((a, x) => a + x.strength, 0) / rest.length;
          cost += (hard ? 6 : 2) * avg * (1 / Math.max(1, tricksLeft - 1));
        }
      }
    }

    // Avoiding tricks in general: Turns penalises every trick won.
    if (round.mode === "Turns" && !pursueCapot) cost += 0.01 * str;

    cost += rng() * (hard ? 0.001 : 0.5);
    if (cost < bestCost) {
      bestCost = cost;
      best = m;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODE SELECTION — pick the mode with the lowest expected penalty for my hand.
// ─────────────────────────────────────────────────────────────────────────────

export function chooseMode(remaining: ModeId[], hand: Card[], difficulty: Difficulty, rng: Rng = Math.random): ModeId {
  if (difficulty !== "hard" || remaining.length === 1) return pick(remaining, rng);
  const queens = hand.filter((c) => c.rank === "Q").length;
  const diamonds = hand.filter((c) => c.suit === "D");
  const hasKH = hand.some((c) => c.suit === "H" && c.rank === "K");
  const hearts = hand.filter((c) => c.suit === "H").length;
  const highCards = hand.filter((c) => c.strength >= 6).length; // A and 10
  const aces = hand.filter((c) => c.strength >= 7).length;
  const neutral = hand.filter((c) => c.rank === "9" || c.rank === "J" || c.rank === "10").length;

  // Expected penalty (points) if this mode is played with this hand. LOWER IS BETTER.
  const cost: Record<ModeId, number> = {
    Queens: queens * 20 * 0.7 + hand.filter((c) => c.strength >= 5).length * 1,
    Diamonds: diamonds.length * 10 * 0.6 + diamonds.filter((c) => c.strength >= 5).length * 4,
    KingOfHearts: hasKH ? 90 + hearts * 4 : hearts * 3,
    Turns: highCards * 10 - 0 + (8 - highCards) * 1,
    LastTrick: aces * 60 + (highCards - aces) * 20,
    // Trix: finishing first is -100, so strong run-building hands make this very attractive.
    Trix: (() => {
      let score = 0;
      for (const suit of ["H", "D", "C", "S"] as const) {
        const inSuit = hand.filter((c) => c.suit === suit);
        if (inSuit.some((c) => c.rank === "J")) score += 2;
        score += inSuit.length * 0.5;
      }
      return 40 - score * 10;
    })(),
    General: highCards * 12 + diamonds.length * 6 + queens * 14 + (hasKH ? 150 : 0),
    FiftyOne: 150 - neutral * 40,
    // Switch/Star: bots avoid picking these directly (handled via autoAct in room.ts)
    Switch: Infinity,
    Star: Infinity,
  };
  const eligible = remaining.filter((m) => m !== "Switch" && m !== "Star");
  const pool = eligible.length > 0 ? eligible : remaining;
  return [...pool].sort((a, b) => cost[a] + rng() * 2 - (cost[b] + rng() * 2))[0];
}

export type { CardData };
