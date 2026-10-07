import { Card } from "./card";
import { CardData, ModeId, Move, Rank, Suit } from "@/types";

export abstract class TrickMode {
  abstract readonly id: ModeId;
  abstract readonly restrictedSuit: Suit | Suit[] | null;
  /** True when capturing this mode's cards is undesirable for AI heuristics. */
  abstract readonly avoid: boolean;
  abstract cardPoints(card: CardData): number;
  trickPoints(cards: CardData[]): number {
    return cards.reduce((s, c) => s + this.cardPoints(c), 0);
  }
  /**
   * Returns a human-readable end-reason string if the completed tricks
   * satisfy an early-termination condition, or null if the round should continue.
   * `completedTricks` is the full list of tricks finished so far (including the latest).
   */
  abstract earlyTermination(completedTricks: { plays: { card: CardData }[] }[]): string | null;
}

export class KingOfHeartsMode extends TrickMode {
  readonly id = "KingOfHearts" as const;
  readonly restrictedSuit: Suit = "H";
  readonly avoid = true;
  cardPoints(c: CardData): number {
    return c.suit === "H" && c.rank === "K" ? 150 : 0;
  }
  earlyTermination(completedTricks: { plays: { card: CardData }[] }[]): string | null {
    for (const t of completedTricks) {
      if (t.plays.some((p) => p.card.suit === "H" && p.card.rank === "K")) {
        return "King of Hearts Captured";
      }
    }
    return null;
  }
}

export class DiamondsMode extends TrickMode {
  readonly id = "Diamonds" as const;
  readonly restrictedSuit: Suit = "D";
  readonly avoid = true;
  /** Total diamonds in a 32-card deck = 8 (7♦ 8♦ 9♦ 10♦ J♦ Q♦ K♦ A♦). */
  private static readonly TOTAL_DIAMONDS = 8;
  cardPoints(c: CardData): number {
    return c.suit === "D" ? 10 : 0;
  }
  earlyTermination(completedTricks: { plays: { card: CardData }[] }[]): string | null {
    let captured = 0;
    for (const t of completedTricks) {
      for (const p of t.plays) {
        if (p.card.suit === "D") captured++;
      }
    }
    return captured >= DiamondsMode.TOTAL_DIAMONDS ? "All Diamonds Captured" : null;
  }
}

export class QueensMode extends TrickMode {
  readonly id = "Queens" as const;
  readonly restrictedSuit = null;
  readonly avoid = true;
  /** Total queens in deck = 4 (Q♥ Q♦ Q♣ Q♠). */
  private static readonly TOTAL_QUEENS = 4;
  cardPoints(c: CardData): number {
    return c.rank === "Q" ? 20 : 0;
  }
  earlyTermination(completedTricks: { plays: { card: CardData }[] }[]): string | null {
    let captured = 0;
    for (const t of completedTricks) {
      for (const p of t.plays) {
        if (p.card.rank === "Q") captured++;
      }
    }
    return captured >= QueensMode.TOTAL_QUEENS ? "All Queens Captured" : null;
  }
}

/** Turns mode: +10 points per trick won. Always plays all 8 tricks. */
export class TurnsMode extends TrickMode {
  readonly id = "Turns" as const;
  readonly restrictedSuit = null;
  readonly avoid = false;
  /** Each trick is worth 10 points to its winner; no per-card points. */
  cardPoints(_c: CardData): number {
    return 0;
  }
  /** Override: award +10 for winning the trick (regardless of card values). */
  trickPoints(_cards: CardData[]): number {
    return 10;
  }
  /** Turns always plays all 8 tricks — no early termination. */
  earlyTermination(_completedTricks: { plays: { card: CardData }[] }[]): string | null {
    return null;
  }
}

/**
 * Last Trick mode: only the winner of the 8th (final) trick scores +100.
 * All other tricks are worth 0. Always plays all 8 tricks.
 */
export class LastTrickMode extends TrickMode {
  readonly id = "LastTrick" as const;
  readonly restrictedSuit = null;
  readonly avoid = false;
  cardPoints(_c: CardData): number {
    return 0;
  }
  trickPoints(_cards: CardData[]): number {
    return 0;
  }
  earlyTermination(_completedTricks: { plays: { card: CardData }[] }[]): string | null {
    return null;
  }
}

export interface GeneralBreakdown {
  kingHearts: number;
  diamonds: number;
  queens: number;
  turns: number;
  lastTrick: number;
  capot: number;
}

export class GeneralMode extends TrickMode {
  readonly id = "General" as const;
  readonly restrictedSuit: Suit[] = ["H", "D"];
  readonly avoid = true;

  cardPoints(c: CardData): number {
    return (c.suit === "H" && c.rank === "K" ? 150 : 0) +
      (c.suit === "D" ? 10 : 0) +
      (c.rank === "Q" ? 20 : 0);
  }
  trickPoints(cards: CardData[]): number {
    return super.trickPoints(cards) + 10;
  }
  earlyTermination(_completedTricks: { plays: { card: CardData }[] }[]): string | null {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIX MODE — shared sequence table engine
// ─────────────────────────────────────────────────────────────────────────────

/** Rank index within the sequence 7(0) 8(1) 9(2) 10(3) J(4) Q(5) K(6) A(7) */
const TRIX_RANKS: Rank[] = ["7", "8", "9", "10", "J", "Q", "K", "A"];
const TRIX_RANK_IDX: Record<Rank, number> = Object.fromEntries(
  TRIX_RANKS.map((r, i) => [r, i]),
) as Record<Rank, number>;

/** Per-suit table range: the lowest and highest index already on the table. */
export interface TrixSuitRange {
  low: number;  // index into TRIX_RANKS
  high: number; // index into TRIX_RANKS
}

/** The shared Trix table state: one range per suit, or null if the suit hasn't been opened. */
export type TrixTable = { H: TrixSuitRange | null; D: TrixSuitRange | null; C: TrixSuitRange | null; S: TrixSuitRange | null };

export const TRIX_SCORES: [number, number, number, number] = [-100, -50, 0, 0];

export class TrixManager {
  /** The shared table: per-suit range of played cards (null = suit not yet opened). */
  readonly table: TrixTable = { H: null, D: null, C: null, S: null };

  /** Finish order: seat indices in the order they emptied their hand (max 2 recorded). */
  readonly finishOrder: number[] = [];

  constructor() {
    // The table starts empty: no suit is opened until the first Jack is played.
    // The first player to hold a Jack opens the first suit chain.
  }

  /** True once at least one suit chain has been opened (a Jack has been played). */
  get started(): boolean {
    return this.table.H !== null || this.table.D !== null || this.table.C !== null || this.table.S !== null;
  }

  /**
   * Legal plays for a seat's hand.
   * Rules:
   *  - A card is legal if it extends an already-open suit (adjacent rank), OR
   *    opens an unopened suit (only that suit's J can do that).
   *  - Before any suit is opened, only Jacks are legal — so the first player
   *    with a Jack must play it and starts the first suit chain.
   *  - Aces are optional: the player may always decline an Ace and PASS, but if
   *    they hold any non-Ace legal card they must play one of those.
   */
  legalMoves(hand: Card[]): Move[] {
    const moves: Move[] = [];
    for (const c of hand) {
      if (this.canPlay(c)) moves.push({ card: c.toJSON() });
    }
    return moves;
  }

  private canPlay(c: Card): boolean {
    const suit = c.suit as keyof TrixTable;
    const idx = TRIX_RANK_IDX[c.rank];
    const range = this.table[suit];
    if (range === null) {
      // Suit not opened: only the J of this suit can open it
      return c.rank === "J";
    }
    // Adjacent to existing range
    return idx === range.low - 1 || idx === range.high + 1;
  }

  /**
   * Apply a card to the table.
   * Returns true if the play was an Ace (grants extra turn).
   */
  applyPlay(card: CardData): boolean {
    const suit = card.suit as keyof TrixTable;
    const idx = TRIX_RANK_IDX[card.rank as Rank];
    const range = this.table[suit];
    if (range === null) {
      // Opening the suit (must be J — canPlay guarantees this)
      if (card.rank !== "J") throw new Error(`Only a Jack can open ${suit}`);
      this.table[suit] = { low: idx, high: idx };
    } else if (idx === range.low - 1) {
      range.low = idx;
    } else if (idx === range.high + 1) {
      range.high = idx;
    } else {
      throw new Error("Illegal Trix play: card does not extend the suit chain");
    }
    return card.rank === "A";
  }

  /** Call when a player empties their hand. Returns true if round should end (2nd finisher). */
  recordFinish(seat: number): boolean {
    if (this.finishOrder.length >= 2) return true; // already done
    this.finishOrder.push(seat);
    return this.finishOrder.length >= 2;
  }

  /** Compute base scores for 4 seats given finish order. Unfinished seats get 0. */
  computeScores(): number[] {
    const scores = [0, 0, 0, 0];
    if (this.finishOrder.length >= 1) scores[this.finishOrder[0]] = TRIX_SCORES[0]; // -100
    if (this.finishOrder.length >= 2) scores[this.finishOrder[1]] = TRIX_SCORES[1]; // -50
    return scores;
  }
}

export const FIFTY_ONE_TARGET = 51;
export const FIFTY_ONE_REWARD = 510;

export class FiftyOneMode {
  readonly id = "FiftyOne" as const;

  /** Delta applied to the center score by a move. */
  static delta(move: Move): number {
    switch (move.card.rank) {
      case "7": return 7;
      case "8": return 8;
      case "9": return 0;
      case "10": return -10;
      case "J": return 0;
      case "Q": return 3;
      case "K": return 4;
      case "A": return move.aceValue === 11 ? 11 : 1;
    }
  }

  /** All candidate moves for a hand, filtered so that the total never exceeds 51. */
  static legalMoves(hand: Card[], total: number): Move[] {
    const moves: Move[] = [];
    for (const c of hand) {
      if (c.rank === "A") {
        for (const v of [1, 11] as const) moves.push({ card: c.toJSON(), aceValue: v });
      } else {
        moves.push({ card: c.toJSON() });
      }
    }
    return moves.filter((m) => total + FiftyOneMode.delta(m) <= FIFTY_ONE_TARGET);
  }

  static next(total: number, move: Move): number {
    return Math.max(0, total + FiftyOneMode.delta(move));
  }
}

/**
 * SwitchMode is a meta-mode: it delegates to any already-completed mode
 * but with ALL players' hands swapped (selector ↔ target, other two ↔ each other)
 * and scores doubled (x2 Switch bonus on top of x2 selector bonus = x4 for selector).
 *
 * The actual card-scoring logic is provided by the sub-mode TrickMode instance.
 * SwitchMode itself just acts as a TrickMode wrapper that is resolved during engine setup.
 */
export class SwitchMode extends TrickMode {
  readonly id = "Switch" as const;
  readonly restrictedSuit = null;
  readonly avoid = false;
  cardPoints(_c: CardData): number { return 0; }
  earlyTermination(_completedTricks: { plays: { card: CardData }[] }[]): string | null { return null; }
}

/**
 * StarMode is a meta-mode: it replays any previously-completed mode (including Switch)
 * with an extra ×2 Star multiplier applied to all seats on top of the normal selector ×2.
 * When replaying Switch, the Star ×2 stacks with the Switch ×2 (selector gets ×8 total).
 */
export class StarMode extends TrickMode {
  readonly id = "Star" as const;
  readonly restrictedSuit = null;
  readonly avoid = false;
  cardPoints(_c: CardData): number { return 0; }
  earlyTermination(_completedTricks: { plays: { card: CardData }[] }[]): string | null { return null; }
}

export class ModeManager {
  private static trickModes: Record<Exclude<ModeId, "FiftyOne" | "Trix">, TrickMode> = {
    KingOfHearts: new KingOfHeartsMode(),
    Diamonds: new DiamondsMode(),
    Queens: new QueensMode(),
    Turns: new TurnsMode(),
    LastTrick: new LastTrickMode(),
    General: new GeneralMode(),
    Switch: new SwitchMode(),
    Star: new StarMode(),
  } as Record<Exclude<ModeId, "FiftyOne" | "Trix">, TrickMode>;

  static isTrickMode(id: ModeId): boolean {
    return id !== "FiftyOne" && id !== "Trix";
  }

  static trick(id: ModeId): TrickMode {
    if (id === "FiftyOne") throw new Error("FiftyOne is not a trick mode");
    if (id === "Trix") throw new Error("Trix is not a trick mode");
    const mm = ModeManager.trickModes as Record<string, TrickMode>;
    return mm[id];
  }

  /**
   * Returns true when Switch can be selected.
   * Requires at least one completed non-Switch, non-Star mode.
   */
  static switchAvailable(allUsed: ModeId[][]): boolean {
    return allUsed.some((u) => u.some((m) => m !== "Switch" && m !== "Star"));
  }

  /**
   * Returns true when Star can be selected.
   * Requires at least one completed mode (any mode, including Switch).
   */
  static starAvailable(allUsed: ModeId[][]): boolean {
    return allUsed.some((u) => u.some((m) => m !== "Star"));
  }

  /**
   * The set of modes completed by at least one player, usable as Switch sub-modes.
   * Excludes Switch and Star themselves.
   */
  static completedModes(allUsed: ModeId[][]): ModeId[] {
    const seen = new Set<ModeId>();
    for (const used of allUsed) {
      for (const m of used) {
        if (m !== "Switch" && m !== "Star") seen.add(m);
      }
    }
    return [...seen];
  }

  /**
   * The set of modes completed by at least one player, usable as Star sub-modes.
   * Excludes Star itself (but includes Switch so Star can replay Switch).
   */
  static completedModesForStar(allUsed: ModeId[][]): ModeId[] {
    const seen = new Set<ModeId>();
    for (const used of allUsed) {
      for (const m of used) {
        if (m !== "Star") seen.add(m);
      }
    }
    return [...seen];
  }
}
