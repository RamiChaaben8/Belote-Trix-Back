import { CardData, RANKS, Rank, SUITS, Suit } from "@/types";

const STRENGTH: Record<Rank, number> = { A: 7, "10": 6, K: 5, Q: 4, J: 3, "9": 2, "8": 1, "7": 0 };

export function strengthOf(rank: Rank): number {
  return STRENGTH[rank];
}

export class Card implements CardData {
  constructor(
    readonly suit: Suit,
    readonly rank: Rank,
  ) {}

  get strength(): number {
    return STRENGTH[this.rank];
  }

  get id(): string {
    return `${this.rank}${this.suit}`;
  }

  equals(other: CardData): boolean {
    return other.suit === this.suit && other.rank === this.rank;
  }

  toJSON(): CardData {
    return { suit: this.suit, rank: this.rank };
  }

  static from(data: CardData): Card {
    return new Card(data.suit, data.rank);
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Deck {
  cards: Card[];

  constructor() {
    this.cards = [];
    for (const s of SUITS) for (const r of RANKS) this.cards.push(new Card(s, r));
  }

  static all(): Card[] {
    return new Deck().cards;
  }

  shuffle(rng: () => number = Math.random): this {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
    return this;
  }

  deal(players = 4, perPlayer = 8): Card[][] {
    const hands: Card[][] = Array.from({ length: players }, () => []);
    for (let i = 0; i < players * perPlayer; i++) hands[i % players].push(this.cards[i]);
    return hands.map((h) => h.sort(sortCards));
  }
}

export function sortCards(a: Card, b: Card): number {
  const si = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  return si !== 0 ? si : b.strength - a.strength;
}
