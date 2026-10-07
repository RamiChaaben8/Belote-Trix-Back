import { Card } from "./card";
import { Play, Suit } from "@/types";

export class TrickEngine {
  static leadSuit(trick: Play[]): Suit | null {
    return trick.length ? trick[0].card.suit : null;
  }

  /** Highest card of the led suit wins. */
  static winner(trick: Play[]): number {
    const led = trick[0].card.suit;
    let best = trick[0];
    for (const p of trick) {
      if (p.card.suit === led && Card.from(p.card).strength > Card.from(best.card).strength) best = p;
    }
    return best.seat;
  }

  /** Seats known to be void in a suit (they failed to follow it). */
  static voids(tricks: Play[][]): Map<number, Set<Suit>> {
    const map = new Map<number, Set<Suit>>();
    for (const t of tricks) {
      if (!t.length) continue;
      const led = t[0].card.suit;
      for (const p of t) {
        if (p.card.suit !== led) {
          if (!map.has(p.seat)) map.set(p.seat, new Set());
          map.get(p.seat)!.add(led);
        }
      }
    }
    return map;
  }
}

export class RuleEngine {
  static legalTrickCards(hand: Card[], trick: Play[], restricted: Suit | Suit[] | null, broken: boolean, brokenSuits?: Set<Suit>): Card[] {
    const restrictions = restricted ? (Array.isArray(restricted) ? restricted : [restricted]) : [];
    if (trick.length > 0) {
      const led = trick[0].card.suit;
      const follow = hand.filter((c) => c.suit === led);
      return follow.length ? follow : [...hand];
    }
    if (restrictions.length > 0) {
      const free = hand.filter((c) => !restrictions.includes(c.suit) || (brokenSuits?.has(c.suit) ?? (broken && c.suit === restrictions[0])));
      return free.length ? free : [...hand];
    }
    return [...hand];
  }

  static isDiscardOfRestricted(card: Card, trick: Play[], restricted: Suit | Suit[] | null, brokenSuits?: Set<Suit>): boolean {
    const restrictions = restricted ? (Array.isArray(restricted) ? restricted : [restricted]) : [];
    return restrictions.includes(card.suit) && !brokenSuits?.has(card.suit) &&
      trick.length > 0 && trick[0].card.suit !== card.suit;
  }
}
