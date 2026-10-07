export const SUITS = ["H", "D", "C", "S"] as const;
export type Suit = (typeof SUITS)[number];
export const RANKS = ["7", "8", "9", "10", "J", "Q", "K", "A"] as const;
export type Rank = (typeof RANKS)[number];
export type ModeId =
  | "KingOfHearts"
  | "Diamonds"
  | "Queens"
  | "Turns"
  | "LastTrick"
  | "Trix"
  | "General"
  | "Switch"
  | "Star"
  | "FiftyOne";
export const MODE_IDS: ModeId[] = [
  "KingOfHearts",
  "Diamonds",
  "Queens",
  "Turns",
  "LastTrick",
  "Trix",
  "General",
  "Switch",
  "Star",
  "FiftyOne",
];
export type Difficulty = "easy" | "medium" | "hard";
export type GameType = "full" | "quick";

export interface CardData {
  suit: Suit;
  rank: Rank;
}

export interface Move {
  card: CardData;
  /** Only meaningful for an Ace in FiftyOne mode. */
  aceValue?: 1 | 11;
  /** Trix mode: request to pass (legal only when there is no non-Ace legal move). */
  trixPass?: boolean;
}

export interface Play {
  seat: number;
  card: CardData;
}

export interface PlayRecord extends Play {
  seq: number;
  trickIndex: number;
  total?: number;
  aceValue?: 1 | 11;
}

export interface TrickRecord {
  index: number;
  leader: number;
  plays: Play[];
  winner: number;
  points: number;
}

export interface EngineEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Phase for the Switch mode multi-step selection flow. */
export type SwitchPhase = "sub_select" | "target_select" | "reveal" | "playing" | null;

/** State held by the engine during a Switch-mode round. */
export interface SwitchState {
  phase: SwitchPhase;
  /** The underlying mode the selector chose (set after step 2). */
  subMode: ModeId | null;
  /** The non-selector player the selector wants to swap with (set after step 3). */
  swapTarget: number | null;
  /** The other swap pair: [seat, seat] (set automatically after swapTarget is chosen). */
  otherPair: [number, number] | null;
  /** Original hands before swap (for the reveal UI). */
  preSwapHands: CardData[][] | null;
  /** Seconds remaining in the reveal countdown. */
  revealCountdown: number;
}

/** State held by the engine during a Star-mode round. */
export interface StarState {
  /**
   * The mode the selector chose to replay under Star.
   * null until the selector picks in the star_sub phase.
   */
  subMode: ModeId | null;
}
