import { Card } from "./card";
import { FIFTY_ONE_REWARD, FIFTY_ONE_TARGET, FiftyOneMode, GeneralBreakdown, ModeManager, TrickMode, TrixManager } from "./modes";
import { RuleEngine, TrickEngine } from "./rules";
import { EngineEvent, ModeId, Move, Play, PlayRecord, Suit, TrickRecord } from "@/types";

export class RoundManager {
  readonly mode: ModeId;
  readonly selector: number;
  readonly initialHands: Card[][];
  hands: Card[][];
  turn: number;
  trick: Play[] = [];
  completed: TrickRecord[] = [];
  plays: PlayRecord[] = [];
  broken = false;
  readonly brokenSuits = new Set<Suit>();
  scores: number[] = [0, 0, 0, 0];
  readonly generalBreakdown: GeneralBreakdown[] = Array.from({ length: 4 }, () => ({
    kingHearts: 0, diamonds: 0, queens: 0, turns: 0, lastTrick: 0, capot: 0,
  }));
  total = 0;
  direction: 1 | -1 = 1;
  finished = false;
  /** Human-readable reason the round ended (set on early termination or normal finish). */
  endReason: string | null = null;
  leader: number;
  /** Trix mode: shared sequence table manager (non-null only for Trix). */
  trix: TrixManager | null = null;

  constructor(mode: ModeId, hands: Card[][], selector: number) {
    this.mode = mode;
    this.selector = selector;
    this.initialHands = hands.map((h) => [...h]);
    this.hands = hands.map((h) => [...h]);

    if (mode === "Trix") {
      // Host (seat 0) always starts first.
      // No card is auto-played: if the host holds Jacks, legalMoves() returns them
      // so the host picks which Jack opens the first suit chain. If the host has no
      // Jacks, legalMoves() is empty and the host presses PASS.
      this.trix = new TrixManager();
      this.turn = 0;
      this.leader = 0;
    } else {
      this.turn = selector;
      this.leader = selector;
    }
  }

  get isFifty(): boolean {
    return this.mode === "FiftyOne";
  }

  get isTrix(): boolean {
    return this.mode === "Trix";
  }

  get isGeneral(): boolean {
    return this.mode === "General";
  }

  private trickMode(): TrickMode {
    return ModeManager.trick(this.mode);
  }

  get restrictedSuit(): Suit | Suit[] | null {
    if (this.isFifty || this.isTrix) return null;
    return this.trickMode().restrictedSuit;
  }

  legalMoves(seat: number): Move[] {
    if (this.finished) return [];
    const hand = this.hands[seat];
    if (this.isFifty) return FiftyOneMode.legalMoves(hand, this.total);
    if (this.isTrix) {
      const moves = this.trix!.legalMoves(hand);
      // If no legal moves: player must pass (represented by empty move list — engine skips them)
      return moves;
    }
    return RuleEngine.legalTrickCards(hand, this.trick, this.restrictedSuit, this.broken, this.brokenSuits).map((c) => ({
      card: c.toJSON(),
    }));
  }

  play(seat: number, move: Move): EngineEvent[] {
    if (this.finished) throw new Error("Round is finished");
    if (seat !== this.turn) throw new Error("Not your turn");
    const legal = this.legalMoves(seat);

    if (this.isTrix) {
      // Explicit PASS: allowed only when there is no legal move at all,
      // or when every legal move is an Ace (the Ace exception).
      if (move.trixPass) {
        const hasNonAceMove = legal.some((m) => m.card.rank !== "A");
        if (hasNonAceMove) throw new Error("You have a card you must play");
        return this.applyTrixPass(seat);
      }
      // No legal moves: the player must pass.
      if (legal.length === 0) {
        return this.applyTrixPass(seat);
      }
      // Find the chosen card in legal moves
      const chosen = legal.find((m) => m.card.suit === move.card.suit && m.card.rank === move.card.rank);
      if (!chosen) throw new Error("Illegal move");
      const idx = this.hands[seat].findIndex((c) => c.equals(chosen.card));
      const [card] = this.hands[seat].splice(idx, 1);
      return this.applyTrix(seat, card);
    }

    let chosen = legal.find(
      (m) =>
        m.card.suit === move.card.suit &&
        m.card.rank === move.card.rank &&
        (!this.isFifty || move.card.rank !== "A" || m.aceValue === move.aceValue),
    );
    if (!chosen && this.isFifty && move.card.rank === "A" && move.aceValue === undefined) {
      chosen = legal.filter((m) => m.card.rank === "A").sort((a, b) => (b.aceValue ?? 0) - (a.aceValue ?? 0))[0];
    }
    if (!chosen) throw new Error("Illegal move");
    const idx = this.hands[seat].findIndex((c) => c.equals(chosen!.card));
    const [card] = this.hands[seat].splice(idx, 1);
    return this.isFifty ? this.applyFifty(seat, card, chosen) : this.applyTrick(seat, card);
  }

  private applyTrixPass(seat: number): EngineEvent[] {
    // Pass — advance to the next seat clockwise, skipping players who already finished.
    const events: EngineEvent[] = [{ type: "player_skipped", data: { seat } }];
    this.turn = (seat + 1) % 4;
    let guard = 0;
    while (guard++ < 4 && this.hands[this.turn].length === 0) {
      this.turn = (this.turn + 1) % 4;
    }
    return events;
  }

  private applyTrix(seat: number, card: Card): EngineEvent[] {
    const events: EngineEvent[] = [];
    const isAce = this.trix!.applyPlay(card.toJSON());
    this.plays.push({ seq: this.plays.length, seat, card: card.toJSON(), trickIndex: -1 });
    events.push({ type: "card_played", data: { seat, card: card.toJSON(), isAce } });

    if (isAce) {
      events.push({ type: "trix_extra_turn", data: { seat } });
    }

    // Check if this player emptied their hand
    if (this.hands[seat].length === 0) {
      const shouldEnd = this.trix!.recordFinish(seat);
      events.push({ type: "trix_finish", data: { seat, place: this.trix!.finishOrder.length } });
      if (shouldEnd) {
        this.scores = this.trix!.computeScores();
        this.endReason = "Trix Finished";
        this.finished = true;
        return events;
      }
    }

    // Advance turn: Ace grants extra turn to same seat (if hand not empty)
    if (isAce && this.hands[seat].length > 0) {
      // Stay on same seat
    } else {
      this.turn = (seat + 1) % 4;
      // Skip seats with no legal moves and no cards (already finished)
      let guard = 0;
      while (guard++ < 4) {
        if (this.hands[this.turn].length === 0) {
          this.turn = (this.turn + 1) % 4;
        } else {
          break;
        }
      }
    }

    return events;
  }

  private applyTrick(seat: number, card: Card): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (RuleEngine.isDiscardOfRestricted(card, this.trick, this.restrictedSuit, this.brokenSuits)) {
      if (!this.brokenSuits.has(card.suit)) events.push({ type: "suit_broken", data: { suit: card.suit } });
      this.brokenSuits.add(card.suit);
      this.broken = true;
    }
    this.trick.push({ seat, card: card.toJSON() });
    this.plays.push({ seq: this.plays.length, seat, card: card.toJSON(), trickIndex: this.completed.length });
    events.push({ type: "card_played", data: { seat, card: card.toJSON() } });
    if (this.trick.length === 4) {
      const winner = TrickEngine.winner(this.trick);
      const points = this.trickMode().trickPoints(this.trick.map((p) => p.card));
      this.scores[winner] += points;
      if (this.isGeneral) {
        this.generalBreakdown[winner].turns += 10;
        for (const p of this.trick) {
          if (p.card.suit === "H" && p.card.rank === "K") this.generalBreakdown[winner].kingHearts += 150;
          if (p.card.suit === "D") this.generalBreakdown[winner].diamonds += 10;
          if (p.card.rank === "Q") this.generalBreakdown[winner].queens += 20;
        }
      }
      const rec: TrickRecord = {
        index: this.completed.length,
        leader: this.leader,
        plays: [...this.trick],
        winner,
        points,
      };
      this.completed.push(rec);
      events.push({ type: "trick_finished", data: { ...rec } });
      this.trick = [];
      this.leader = winner;
      this.turn = winner;

      // ── Early-termination check ──────────────────────────────────
      const earlyReason = this.trickMode().earlyTermination(this.completed);
      if (earlyReason !== null) {
        this.endReason = earlyReason;
        this.finished = true;
      } else if (this.hands.every((h) => h.length === 0)) {
        // All 8 tricks played — mode-specific final scoring
        if (this.mode === "Turns") {
          const capotSeat = this.scores.findIndex((s) => s === 80); // 8 tricks × 10
          if (capotSeat !== -1) {
            // Capot: override scores — winner gets -100, others get +100
            this.scores = this.scores.map((_, s) => (s === capotSeat ? -100 : 100));
            this.endReason = "Capot";
          }
        } else if (this.mode === "LastTrick") {
          // Award +100 to the winner of the final (8th) trick
          this.scores[winner] += 100;
          this.endReason = "Last Trick Won";
        } else if (this.isGeneral) {
          this.generalBreakdown[winner].lastTrick += 100;
          this.scores[winner] += 100;
          const capotSeat = this.completed.every((t) => t.winner === winner) ? winner : -1;
          if (capotSeat !== -1) {
            this.generalBreakdown[capotSeat].capot -= 1000;
            for (let seat = 0; seat < 4; seat++) {
              if (seat !== capotSeat) {
                this.generalBreakdown[seat].capot += 1000;
                this.scores[seat] += 1000;
              }
            }
            this.scores[capotSeat] -= 1000;
            this.endReason = "Capot";
          } else {
            this.endReason = "General Completed";
          }
        }
        this.finished = true;
      }
      // ─────────────────────────────────────────────────────────────
    } else {
      this.turn = (seat + 1) % 4;
    }
    return events;
  }

  private applyFifty(seat: number, card: Card, move: Move): EngineEvent[] {
    const events: EngineEvent[] = [];
    this.total = FiftyOneMode.next(this.total, move);
    if (card.rank === "J") this.direction = (this.direction * -1) as 1 | -1;
    this.plays.push({
      seq: this.plays.length,
      seat,
      card: card.toJSON(),
      trickIndex: -1,
      total: this.total,
      aceValue: move.aceValue,
    });
    events.push({
      type: "card_played",
      data: { seat, card: card.toJSON(), total: this.total, direction: this.direction, aceValue: move.aceValue ?? null },
    });
    if (this.total === FIFTY_ONE_TARGET) {
      this.scores[seat] += FIFTY_ONE_REWARD;
      this.endReason = "51 Reached";
      this.finished = true;
      return events;
    }
    let next = seat;
    for (let i = 0; i < 4; i++) {
      next = (next + this.direction + 4) % 4;
      if (this.legalMoves(next).length > 0) {
        this.turn = next;
        return events;
      }
      if (this.hands[next].length > 0) events.push({ type: "player_skipped", data: { seat: next } });
    }
    // No player has a legal move or cards ran out without hitting 51 directly.
    // The player who made the last legal move survived and wins the round!
    this.scores[seat] += FIFTY_ONE_REWARD;
    this.endReason = this.hands.every((h) => h.length === 0) ? "Cards Depleted" : "No Legal Moves Left";
    this.finished = true;
    return events;
  }
}
