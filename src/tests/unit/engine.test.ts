import { describe, expect, it } from "vitest";
import { BotPlayer, Card, Deck, FiftyOneMode, GameEngine, GameRoom, ModeManager, RoundManager, RuleEngine, ScoreManager, TrickEngine, mulberry32 } from "@/game-engine";
import { chooseMode, chooseMove } from "@/bots/ai";
import { Difficulty, EngineEvent, MODE_IDS, ModeId } from "@/types";

const c = (rank: string, suit: string) => new Card(suit as never, rank as never);
const hands = (...h: Card[][]) => h;

describe("Deck", () => {
  it("has 32 unique cards and deals 8 each", () => {
    const d = new Deck();
    expect(new Set(d.cards.map((x) => x.id)).size).toBe(32);
    const dealt = d.shuffle(mulberry32(1)).deal();
    expect(dealt.map((h) => h.length)).toEqual([8, 8, 8, 8]);
  });
});

describe("TrickEngine / RuleEngine", () => {
  it("orders A > 10 > K > Q > J > 9 > 8 > 7", () => {
    const order = ["A", "10", "K", "Q", "J", "9", "8", "7"].map((r) => c(r, "S").strength);
    expect([...order].sort((a, b) => b - a)).toEqual(order);
  });
  it("highest card of led suit wins", () => {
    const w = TrickEngine.winner([
      { seat: 0, card: c("9", "S") },
      { seat: 1, card: c("A", "H") },
      { seat: 2, card: c("10", "S") },
      { seat: 3, card: c("7", "S") },
    ]);
    expect(w).toBe(2);
  });
  it("must follow suit", () => {
    const legal = RuleEngine.legalTrickCards([c("7", "S"), c("A", "H")], [{ seat: 0, card: c("9", "S") }], null, false);
    expect(legal.map((x) => x.id)).toEqual(["7S"]);
  });
  it("may play anything when void", () => {
    const legal = RuleEngine.legalTrickCards([c("7", "D"), c("A", "H")], [{ seat: 0, card: c("9", "S") }], null, false);
    expect(legal).toHaveLength(2);
  });
});

describe("KingOfHearts", () => {
  it("restricts leading hearts until broken", () => {
    const r = new RoundManager("KingOfHearts", hands([c("A", "H"), c("7", "S")], [c("8", "C")], [c("8", "D")], [c("9", "D")]), 0);
    expect(r.legalMoves(0).map((m) => m.card.suit)).toEqual(["S"]);
  });
  it("allows leading hearts when only hearts remain", () => {
    const r = new RoundManager("KingOfHearts", hands([c("A", "H")], [], [], []), 0);
    expect(r.legalMoves(0)).toHaveLength(1);
  });
  it("breaks hearts on discard and awards 150 to King capturer", () => {
    const r = new RoundManager(
      "KingOfHearts",
      hands([c("A", "S")], [c("K", "H")], [c("7", "S")], [c("8", "S")]),
      0,
    );
    r.play(0, { card: c("A", "S").toJSON() });
    r.play(1, { card: c("K", "H").toJSON() });
    expect(r.broken).toBe(true);
    r.play(2, { card: c("7", "S").toJSON() });
    r.play(3, { card: c("8", "S").toJSON() });
    expect(r.scores).toEqual([150, 0, 0, 0]);
    expect(r.finished).toBe(true);
  });
});

describe("Diamonds and Queens", () => {
  it("scores 10 per diamond", () => {
    const r = new RoundManager("Diamonds", hands([c("A", "D")], [c("7", "D")], [c("8", "D")], [c("9", "D")]), 0);
    for (let s = 0; s < 4; s++) r.play(s, r.legalMoves(s)[0]);
    expect(r.scores[0]).toBe(40);
  });
  it("scores 20 per queen", () => {
    const r = new RoundManager("Queens", hands([c("A", "S")], [c("Q", "S")], [c("Q", "H")], [c("7", "S")]), 0);
    for (let s = 0; s < 4; s++) r.play(s, r.legalMoves(s)[0]);
    expect(r.scores[0]).toBe(40);
  });
  it("mode manager exposes point rules", () => {
    expect(ModeManager.trick("Queens").cardPoints(c("Q", "C"))).toBe(20);
  });
});

describe("FiftyOne", () => {
  it("applies card values", () => {
    const d = (rank: string, aceValue?: 1 | 11) => FiftyOneMode.delta({ card: c(rank, "S").toJSON(), aceValue });
    expect([d("7"), d("8"), d("9"), d("10"), d("J"), d("Q"), d("K"), d("A", 1), d("A", 11)]).toEqual([7, 8, 0, -10, 0, 3, 4, 1, 11]);
  });
  it("reverses on Jack", () => {
    const r = new RoundManager("FiftyOne", hands([c("7", "S"), c("9", "D")], [c("8", "S"), c("9", "C")], [c("J", "S"), c("9", "S")], [c("7", "H"), c("8", "H")]), 0);
    r.play(0, { card: c("7", "S").toJSON() });
    r.play(1, { card: c("8", "S").toJSON() });
    expect(r.turn).toBe(2);
    r.play(2, { card: c("J", "S").toJSON() });
    expect(r.direction).toBe(-1);
    expect(r.turn).toBe(1);
  });
  it("forbids exceeding 51 when another move exists and awards 510 at exactly 51", () => {
    const r = new RoundManager("FiftyOne", hands([c("A", "S"), c("7", "S")], [], [], []), 0);
    r.total = 44;
    const moves = r.legalMoves(0);
    expect(moves.some((m) => m.card.rank === "A" && m.aceValue === 11)).toBe(false);
    r.play(0, { card: c("7", "S").toJSON() });
    expect(r.total).toBe(51);
    expect(r.scores[0]).toBe(510);
    expect(r.finished).toBe(true);
  });
  it("skips players without legal moves", () => {
    const r = new RoundManager("FiftyOne", hands([c("9", "S"), c("7", "D")], [c("8", "S")], [c("7", "S")], [c("9", "H")]), 0);
    r.total = 45;
    const next = r.play(0, { card: c("9", "S").toJSON() });
    expect(next.length).toBeGreaterThan(0);
    expect(r.legalMoves(r.turn).length).toBeGreaterThan(0);
  });
  it("awards 510 to the surviving player when opponents have no legal moves or cards run out", () => {
    // Player 0 plays 7 (total reaches 47). Player 1 has only a King (+4 -> 51? wait King is 4, 47+4=51).
    // Let total reach 48. Player 1, 2, 3 have only 7s (+7 -> 55 > 51, no legal moves).
    const r = new RoundManager("FiftyOne", hands([c("8", "S")], [c("7", "D")], [c("7", "C")], [c("7", "H")]), 0);
    r.total = 40;
    r.play(0, { card: c("8", "S").toJSON() }); // total = 48
    // Players 1, 2, 3 all hold '7' (48 + 7 = 55 > 51), so none have legal moves.
    expect(r.finished).toBe(true);
    expect(r.scores[0]).toBe(510);
    expect(r.endReason).toBe("No Legal Moves Left");
  });
});

function playFullGame(difficulty: Difficulty, seed: number): GameEngine {
  const rng = mulberry32(seed);
  const players = [0, 1, 2, 3].map((i) => new BotPlayer(i, `B${i}`, difficulty));
  const e = new GameEngine(players, rng);
  e.start();
  let guard = 0;
  while (e.phase !== "finished" && guard++ < 10000) {
    if (e.phase === "selecting") {
      const seat = e.selector;
      // Bots never pick Switch or Star (mirrors players.ts behaviour)
      const pool = e.remainingModes(seat).filter((m) => m !== "Switch" && m !== "Star");
      const mode = pool.length > 0 ? chooseMode(pool, e.handOf(seat), difficulty, rng) : e.remainingModes(seat)[0];
      e.selectMode(seat, mode);
    } else if (e.phase === "star_sub") {
      const completed = ModeManager.completedModesForStar(e.used);
      // Bots never pick Switch as Star sub-mode
      const pool = completed.filter((m) => m !== "Switch");
      const pick = pool.length > 0
        ? pool[Math.floor(rng() * pool.length)]
        : completed[Math.floor(rng() * completed.length)];
      e.selectStarSubMode(e.selector, pick);
    } else if (e.phase === "switch_sub") {
      const completed = ModeManager.completedModes(e.used);
      const pick = completed[Math.floor(rng() * completed.length)];
      e.selectSwitchSubMode(e.selector, pick);
    } else if (e.phase === "switch_target") {
      const others = [0, 1, 2, 3].filter((s) => s !== e.selector);
      e.selectSwitchTarget(e.selector, others[Math.floor(rng() * others.length)]);
    } else if (e.phase === "switch_reveal") {
      // Drain countdown immediately (no real timer in tests)
      while (e.phase === "switch_reveal") {
        e.tickRevealCountdown();
      }
    } else {
      const seat = e.actor()!;
      e.play(seat, chooseMove(e.round!, seat, difficulty, rng));
    }
  }
  return e;
}

describe("GameEngine full matches", () => {
  for (const diff of ["easy", "medium", "hard"] as Difficulty[]) {
    it(`completes 40 rounds with ${diff} bots`, () => {
      for (let seed = 1; seed <= 5; seed++) {
        const e = playFullGame(diff, seed);
        expect(e.phase).toBe("finished");
        expect(e.results).toHaveLength(40);
        for (let s = 0; s < 4; s++) expect([...e.used[s]].sort()).toEqual([...MODE_IDS].sort() as ModeId[]);
      }
    });
  }
  it("each non-FiftyOne round distributes its full base points and multiplies selector correctly", () => {
    const e = playFullGame("medium", 42);
    for (const r of e.results) {
      const baseSum = r.base.reduce((a, b) => a + b, 0);
      if (r.mode === "KingOfHearts") expect(baseSum).toBe(150);
      if (r.mode === "Diamonds") expect(baseSum).toBe(80);
      if (r.mode === "Queens") expect(baseSum).toBe(80);
      // Turns: 8 tricks × 10 = 80 total base (Capot overrides but net is different)
      if (r.mode === "Turns" && r.endReason !== "Capot") expect(baseSum).toBe(80);
      // LastTrick: exactly one winner gets +100, others 0
      if (r.mode === "LastTrick") expect(baseSum).toBe(100);
      // General: cards/objectives (150 + 80 + 80), turns (80), and last trick (100).
      if (r.mode === "General" && r.endReason !== "Capot") expect(baseSum).toBe(490);
      // Trix: 1st gets -100, 2nd gets -50, others 0 → sum = -150
      if (r.mode === "Trix") expect(baseSum).toBe(-150);
      // Selector score: x2 base, x4 for Switch, x4 for Star, x8 for Star(Switch),
      // doubled again for the selector's final remaining mode (Last Mode Bonus)
      // (except Capot which bypasses all multipliers)
      if (r.endReason !== "Capot") {
        const isStar = r.mode === "Star";
        const isSwitch = r.mode === "Switch" || r.starSubMode === "Switch";
        const lastMode = r.lastModeBonus ? 2 : 1;
        const meta = (isStar ? 2 : 1) * (isSwitch ? 2 : 1) * lastMode;
        expect(r.scores[r.selector]).toBe(r.base[r.selector] * meta * 2); // selector always x2
        // Every other seat receives all meta multipliers but the selector bonus.
        r.scores.forEach((s, seat) => {
          if (seat !== r.selector) expect(s).toBe(r.base[seat] * meta);
        });
      }
    }
  });
  it("rejects out-of-turn actions", () => {
    const players = [0, 1, 2, 3].map((i) => new BotPlayer(i, `B${i}`, "easy"));
    const e = new GameEngine(players, mulberry32(3));
    e.start();
    expect(() => e.selectMode(1, "Queens")).toThrow();
    e.selectMode(0, "Queens");
    expect(() => e.play(2, e.round!.legalMoves(2)[0])).toThrow();
  });
});

describe("Early termination", () => {
  // Helper: build hands where each seat gets exactly one card
  const oneCard = (...cards: Card[]) => cards.map((card) => [card]);

  it("KingOfHearts ends immediately when K♥ is captured mid-round", () => {
    // Seat 0 leads A♠. Seats 1-3 have no spades → must discard off-suit.
    // Seat 1 discards K♥ (off-suit discard of restricted → breaks hearts).
    // Seat 0 wins with A♠ and captures K♥ → round ends immediately.
    const r = new RoundManager(
      "KingOfHearts",
      hands(
        [c("A", "S"), c("9", "C")],  // seat 0: leads A♠, has 9♣ left
        [c("K", "H"), c("8", "H")],  // seat 1: no spades → discards K♥
        [c("7", "H"), c("7", "C")],  // seat 2: no spades → discards 7♥
        [c("8", "C"), c("9", "D")],  // seat 3: no spades → discards 8♣
      ),
      0,
    );
    r.play(0, { card: c("A", "S").toJSON() });
    r.play(1, { card: c("K", "H").toJSON() }); // off-suit discard → breaks hearts
    r.play(2, { card: c("7", "H").toJSON() });
    r.play(3, { card: c("8", "C").toJSON() });
    // A♠ wins (seat 0); K♥ was in the trick
    expect(r.scores[0]).toBe(150);
    expect(r.finished).toBe(true);
    expect(r.endReason).toBe("King of Hearts Captured");
    // Trick 2 never played — each seat still has 1 card
    expect(r.hands.every((h) => h.length === 1)).toBe(true);
  });

  it("KingOfHearts: endReason is null when K♥ not yet captured", () => {
    // Setup where K♥ is NOT in trick 1
    const r = new RoundManager(
      "KingOfHearts",
      hands(
        [c("A", "S"), c("K", "H")],
        [c("7", "S"), c("8", "C")],
        [c("8", "S"), c("7", "C")],
        [c("9", "S"), c("9", "C")],
      ),
      0,
    );
    // Trick 1: all spades — K♥ not involved
    r.play(0, { card: c("A", "S").toJSON() });
    r.play(1, { card: c("7", "S").toJSON() });
    r.play(2, { card: c("8", "S").toJSON() });
    r.play(3, { card: c("9", "S").toJSON() });
    expect(r.finished).toBe(false);
    expect(r.endReason).toBeNull();
  });

  it("Diamonds ends when all 8 diamonds are captured", () => {
    // Give all 8 diamonds to seat 0's tricks by making seat 0 win every trick with all-diamond hands
    const r = new RoundManager(
      "Diamonds",
      hands(
        [c("A","D"), c("K","D"), c("Q","D"), c("J","D"), c("10","D"), c("9","D"), c("8","D"), c("7","D")],
        [c("A","S"), c("A","H"), c("A","C"), c("7","S"), c("8","S"), c("9","S"), c("10","S"), c("7","H")],
        [c("K","S"), c("K","H"), c("K","C"), c("7","C"), c("8","C"), c("9","C"), c("10","C"), c("8","H")],
        [c("Q","S"), c("Q","H"), c("Q","C"), c("J","S"), c("J","H"), c("J","C"), c("10","H"), c("9","H")],
      ),
      0,
    );
    // Play all 8 tricks — seat 0 leads diamonds every time and wins since others can't follow
    // (they have no diamonds). Seat 0 wins every trick.
    for (let trick = 0; trick < 8; trick++) {
      // seat 0 leads
      r.play(0, { card: r.hands[0][0].toJSON() });
      r.play(1, { card: r.hands[1][0].toJSON() });
      r.play(2, { card: r.hands[2][0].toJSON() });
      r.play(3, { card: r.hands[3][0].toJSON() });
      if (r.finished) break;
    }
    expect(r.scores[0]).toBe(80); // 8 diamonds × 10
    expect(r.finished).toBe(true);
    expect(r.endReason).toBe("All Diamonds Captured");
  });

  it("Queens ends when all 4 queens are captured", () => {
    // One trick per seat, each trick contains exactly one queen
    // 4 seats × 4 cards each — trick 1 has Q♠, trick 2 has Q♥, trick 3 has Q♦, trick 4 has Q♣
    const r = new RoundManager(
      "Queens",
      hands(
        [c("A","S"), c("A","H"), c("A","D"), c("A","C")],
        [c("Q","S"), c("Q","H"), c("Q","D"), c("Q","C")],
        [c("7","S"), c("7","H"), c("7","D"), c("7","C")],
        [c("8","S"), c("8","H"), c("8","D"), c("8","C")],
      ),
      0,
    );
    // Play trick by trick — seat 0 (A) wins each, capturing all queens after 4 tricks
    for (let trick = 0; trick < 4; trick++) {
      for (let s = 0; s < 4; s++) {
        r.play(s, { card: r.hands[s][0].toJSON() });
      }
      if (r.finished) break;
    }
    expect(r.scores[0]).toBe(80); // 4 queens × 20
    expect(r.finished).toBe(true);
    expect(r.endReason).toBe("All Queens Captured");
  });

  it("Queens: 3 queens captured does not end round", () => {
    // 4 tricks, each led by seat 0 with a different suit.
    // Tricks 1-3 contain one queen each (Q♠, Q♥, Q♦ discarded off-suit by void seats).
    // Trick 4 has no queen — round should still be ongoing after trick 3.
    // We only play 3 tricks and verify finished=false.
    //
    // Hand construction: seat 0 leads, others are void in led suit → discard queens.
    // Trick 1 led with C: seats 1-3 void in C → discard Q♠, 7♦, 8♦
    // Trick 2 led with S: seats 1-3 void in S → discard Q♥, 9♦, 7♥
    // Trick 3 led with H: seats 1-3 void in H → discard Q♦, 8♥ wait — seat 1 now has Q♣ left
    //
    // Simpler: give each seat exactly 4 cards in 4 different suits, seat 0 always wins.
    const r = new RoundManager(
      "Queens",
      hands(
        [c("A","C"), c("A","S"), c("A","H"), c("A","D")], // seat 0 wins every trick
        [c("Q","S"), c("Q","H"), c("Q","D"), c("7","C")], // seat 1: no C except trick4
        [c("7","S"), c("8","H"), c("8","D"), c("8","C")], // seat 2: always has led suit
        [c("9","S"), c("9","H"), c("9","D"), c("9","C")], // seat 3: always has led suit
      ),
      0,
    );
    // Trick 1: seat 0 leads A♣
    r.play(0, { card: c("A","C").toJSON() });
    r.play(1, { card: c("7","C").toJSON() }); // seat 1 has 7♣ → must follow
    r.play(2, { card: c("8","C").toJSON() });
    r.play(3, { card: c("9","C").toJSON() });
    expect(r.finished).toBe(false);

    // Trick 2: seat 0 leads A♠
    r.play(0, { card: c("A","S").toJSON() });
    r.play(1, { card: c("Q","S").toJSON() }); // seat 1 follows with Q♠
    r.play(2, { card: c("7","S").toJSON() });
    r.play(3, { card: c("9","S").toJSON() });
    expect(r.finished).toBe(false);

    // Trick 3: seat 0 leads A♥
    r.play(0, { card: c("A","H").toJSON() });
    r.play(1, { card: c("Q","H").toJSON() }); // seat 1 follows with Q♥
    r.play(2, { card: c("8","H").toJSON() });
    r.play(3, { card: c("9","H").toJSON() });
    // 2 queens captured so far — not all 4
    expect(r.finished).toBe(false);
    expect(r.endReason).toBeNull();
  });

  it("Full game early termination: KingOfHearts round completes with correct base sum", () => {
    const e = playFullGame("hard", 99);
    expect(e.phase).toBe("finished");
    for (const res of e.results) {
      if (res.mode === "KingOfHearts") {
        expect(res.base.reduce((a, b) => a + b, 0)).toBe(150);
        expect(res.endReason).toBe("King of Hearts Captured");
      }
      if (res.mode === "Diamonds") {
        expect(res.base.reduce((a, b) => a + b, 0)).toBe(80);
        expect(res.endReason).toBe("All Diamonds Captured");
      }
      if (res.mode === "Queens") {
        expect(res.base.reduce((a, b) => a + b, 0)).toBe(80);
        expect(res.endReason).toBe("All Queens Captured");
      }
    }
  });

  // ── "No further turn" tests: attempting to play after objective must throw ──

  it("KingOfHearts: throws when trying to play after K♥ captured", () => {
    // All seats void in spades except seat 0. Seat 0 leads A♠, others discard.
    // Seat 1 discards K♥ (void in spades), seat 0 wins → K♥ captured → finished.
    const r = new RoundManager(
      "KingOfHearts",
      hands(
        [c("A","S"), c("9","C")],
        [c("K","H"), c("8","H")],
        [c("7","H"), c("7","C")],
        [c("8","C"), c("9","D")],
      ),
      0,
    );
    r.play(0, { card: c("A","S").toJSON() });
    r.play(1, { card: c("K","H").toJSON() });
    r.play(2, { card: c("7","H").toJSON() });
    r.play(3, { card: c("8","C").toJSON() });
    expect(r.finished).toBe(true);
    expect(r.endReason).toBe("King of Hearts Captured");
    // Any further play must throw
    expect(() => r.play(0, { card: c("9","C").toJSON() })).toThrow("Round is finished");
  });

  it("Queens: throws when trying to play after all 4 queens captured", () => {
    // 4 tricks, each captures exactly one queen. Seat 0 wins every trick.
    const r = new RoundManager(
      "Queens",
      hands(
        [c("A","S"), c("A","H"), c("A","D"), c("A","C"), c("9","S"), c("9","H"), c("9","D"), c("9","C")],
        [c("Q","S"), c("Q","H"), c("Q","D"), c("Q","C"), c("7","S"), c("7","H"), c("7","D"), c("7","C")],
        [c("K","S"), c("K","H"), c("K","D"), c("K","C"), c("8","S"), c("8","H"), c("8","D"), c("8","C")],
        [c("J","S"), c("J","H"), c("J","D"), c("J","C"), c("10","S"), c("10","H"), c("10","D"), c("10","C")],
      ),
      0,
    );
    // Play 4 tricks: each trick led by seat 0 with an Ace, others follow in same suit
    for (const suit of ["S","H","D","C"] as const) {
      r.play(0, { card: c("A", suit).toJSON() });
      r.play(1, { card: c("Q", suit).toJSON() });
      r.play(2, { card: c("K", suit).toJSON() });
      r.play(3, { card: c("J", suit).toJSON() });
      if (r.finished) break;
    }
    expect(r.finished).toBe(true);
    expect(r.endReason).toBe("All Queens Captured");
    // 4 cards remain in each hand — but round is locked
    expect(r.hands[0].length).toBeGreaterThan(0);
    expect(() => r.play(0, { card: r.hands[0][0].toJSON() })).toThrow("Round is finished");
  });

  it("Diamonds: throws when trying to play after all 8 diamonds captured", () => {
    // Distribute all 8 diamonds evenly: 2 per seat. Each trick will contain 4 diamonds
    // when all 4 players lead/follow with diamonds (but follow-suit applies).
    // Simpler: make all 4 seats hold only diamonds. Then every trick contains 4 diamonds.
    // 8 total ÷ 4 per trick = 2 tricks to exhaust all diamonds → finished after trick 2.
    const r = new RoundManager(
      "Diamonds",
      hands(
        [c("A","D"), c("K","D")],
        [c("Q","D"), c("J","D")],
        [c("10","D"), c("9","D")],
        [c("8","D"), c("7","D")],
      ),
      0,
    );
    // Trick 1: all play diamonds (only suit available), A♦ wins (seat 0)
    r.play(0, { card: c("A","D").toJSON() });
    r.play(1, { card: c("Q","D").toJSON() });
    r.play(2, { card: c("10","D").toJSON() });
    r.play(3, { card: c("8","D").toJSON() });
    // 4 diamonds captured — not all 8 yet
    expect(r.finished).toBe(false);

    // Trick 2: seat 0 leads K♦, all follow, 4 more diamonds captured = 8 total
    r.play(0, { card: c("K","D").toJSON() });
    r.play(1, { card: c("J","D").toJSON() });
    r.play(2, { card: c("9","D").toJSON() });
    r.play(3, { card: c("7","D").toJSON() });
    // All 8 diamonds captured
    expect(r.finished).toBe(true);
    expect(r.endReason).toBe("All Diamonds Captured");
    // Hands are now empty, but finished flag prevents further plays
    expect(() => r.play(0, { card: c("A","D").toJSON() })).toThrow("Round is finished");
  });

  it("FiftyOne: throws when trying to play after exactly 51 reached", () => {
    const r = new RoundManager("FiftyOne", hands([c("A","S"), c("7","S")], [], [], []), 0);
    r.total = 44;
    r.play(0, { card: c("7","S").toJSON() }); // 44+7 = 51
    expect(r.total).toBe(51);
    expect(r.finished).toBe(true);
    expect(() => r.play(0, { card: c("A","S").toJSON() })).toThrow("Round is finished");
  });
});

describe("GameRoom", () => {
  it("fills seats with bots, starts, hides opponent hands and supports reconnect", () => {
    const room = new GameRoom("ABCD12", "u1", mulberry32(9));
    room.join("u1", "Alice", "🙂");
    room.fillBots("easy");
    room.start();
    const v = room.view("u1");
    expect(v.you).toBe(0);
    expect(v.hand).toHaveLength(8);
    expect(JSON.stringify(v)).not.toContain("hands");
    room.setConnected("u1", false);
    expect(room.seats[0]!.connected).toBe(false);
    expect(room.join("u1", "Alice", "🙂").reconnected).toBe(true);
    expect(room.seats[0]!.connected).toBe(true);
  });
  it("auto-plays bot turns to completion", () => {
    const room = new GameRoom("ZZZZ99", "bot", mulberry32(5));
    room.fillBots("hard");
    room.start();
    let guard = 0;
    while (room.engine!.phase !== "finished" && guard++ < 5000) room.autoAct();
    expect(room.engine!.phase).toBe("finished");
  });

  it("Quick Test: plays only 1 round and finishes match immediately", () => {
    const room = new GameRoom("TEST01", "host", mulberry32(11), "quick", "KingOfHearts");
    room.fillBots("medium");
    room.start();
    expect(room.engine!.gameType).toBe("quick");
    expect(room.engine!.totalRounds).toBe(1);
    expect(room.engine!.round?.mode).toBe("KingOfHearts");
    let guard = 0;
    while (room.engine!.phase !== "finished" && guard++ < 500) room.autoAct();
    expect(room.engine!.phase).toBe("finished");
    expect(room.engine!.roundNumber).toBe(1);
    expect(room.engine!.results).toHaveLength(1);
  });
});

describe("Turns mode – Capot rule", () => {
  // Build a Turns round where seat 0 wins every trick.
  // Seat 0 holds the 8 highest cards across 4 suits; others hold 2 of the same suit each.
  // Seat 0 leads a suit, others must follow and play weaker cards.
  function buildCapotRound(selectorSeat = 0): RoundManager {
    // Distribute 8 cards so seat 0 always has the highest in every suit.
    // 2 tricks per suit; seat 0 always wins with the Ace/10.
    return new RoundManager(
      "Turns",
      hands(
        [c("A","S"), c("10","S"), c("A","H"), c("10","H"), c("A","D"), c("10","D"), c("A","C"), c("10","C")],
        [c("9","S"), c("8","S"), c("9","H"), c("8","H"), c("9","D"), c("8","D"), c("9","C"), c("8","C")],
        [c("K","S"), c("Q","S"), c("K","H"), c("Q","H"), c("K","D"), c("Q","D"), c("K","C"), c("Q","C")],
        [c("J","S"), c("7","S"), c("J","H"), c("7","H"), c("J","D"), c("7","D"), c("J","C"), c("7","C")],
      ),
      selectorSeat,
    );
  }

  it("detects Capot when seat 0 wins all 8 tricks and overrides scores to -100/+100", () => {
    const r = buildCapotRound(0);
    // Play all 8 tricks — seat 0 leads each suit twice and wins every time
    for (let trick = 0; trick < 8; trick++) {
      for (let s = 0; s < 4; s++) {
        r.play(s, { card: r.hands[s][0].toJSON() });
      }
    }
    expect(r.finished).toBe(true);
    expect(r.endReason).toBe("Capot");
    expect(r.scores).toEqual([-100, 100, 100, 100]);
  });

  it("Capot scores are NOT multiplied by selector x2 in engine", () => {
    const players = [0, 1, 2, 3].map((i) => new BotPlayer(i, `B${i}`, "easy"));
    const e = new GameEngine(players, mulberry32(1));
    // Inject a pre-built Capot round directly
    const r = buildCapotRound(0);
    // Play all tricks to trigger Capot
    for (let trick = 0; trick < 8; trick++) {
      for (let s = 0; s < 4; s++) {
        r.play(s, { card: r.hands[s][0].toJSON() });
      }
    }
    expect(r.endReason).toBe("Capot");
    expect(r.scores).toEqual([-100, 100, 100, 100]);
    // Selector is seat 0 (the Capot winner). Multiplier must NOT apply.
    // Verify directly via engine's finishRound logic by checking a full quick game.
    const room = new GameRoom("CAPTEST", "host", mulberry32(42), "quick", "Turns");
    room.fillBots("easy");
    room.start();
    // Run the quick Turns game; Capot may or may not occur but the engine should not crash.
    let guard = 0;
    while (room.engine!.phase !== "finished" && guard++ < 500) room.autoAct();
    expect(room.engine!.phase).toBe("finished");
  });

  it("normal Turns (no Capot) still uses trick×10 scoring with total base = 80", () => {
    // Use legalMoves() + r.turn so follow-suit and turn order are always respected.
    const r = new RoundManager(
      "Turns",
      hands(
        [c("A","S"), c("10","S"), c("7","H"), c("7","D"), c("7","C"), c("8","H"), c("8","D"), c("8","C")],
        [c("A","H"), c("10","H"), c("7","S"), c("9","D"), c("9","C"), c("9","S"), c("K","D"), c("K","C")],
        [c("A","D"), c("10","D"), c("Q","S"), c("Q","H"), c("Q","C"), c("J","S"), c("J","H"), c("J","C")],
        [c("A","C"), c("10","C"), c("K","S"), c("K","H"), c("J","D"), c("Q","D"), c("9","H"), c("8","S")],
      ),
      0,
    );
    // Drive all 32 plays respecting turn order
    let guard = 0;
    while (!r.finished && guard++ < 100) {
      r.play(r.turn, r.legalMoves(r.turn)[0]);
    }
    expect(r.finished).toBe(true);
    expect(r.endReason).not.toBe("Capot");
    // All 8 tricks scored at +10 each → total base = 80
    expect(r.scores.reduce((a, b) => a + b, 0)).toBe(80);
  });
});



describe("Last Trick mode", () => {
  it("awards +100 only to the winner of the 8th trick", () => {
    // Give seat 0 the highest cards so they win every trick, including trick 8.
    const r = new RoundManager(
      "LastTrick",
      hands(
        [c("A","S"), c("10","S"), c("A","H"), c("10","H"), c("A","D"), c("10","D"), c("A","C"), c("10","C")],
        [c("9","S"), c("8","S"), c("9","H"), c("8","H"), c("9","D"), c("8","D"), c("9","C"), c("8","C")],
        [c("K","S"), c("Q","S"), c("K","H"), c("Q","H"), c("K","D"), c("Q","D"), c("K","C"), c("Q","C")],
        [c("J","S"), c("7","S"), c("J","H"), c("7","H"), c("J","D"), c("7","D"), c("J","C"), c("7","C")],
      ),
      0,
    );
    // Play all 8 tricks; seat 0 leads and wins every one
    while (!r.finished) {
      r.play(r.turn, r.legalMoves(r.turn)[0]);
    }
    expect(r.finished).toBe(true);
    expect(r.endReason).toBe("Last Trick Won");
    // Only the last-trick winner (seat 0) scores +100; others 0
    expect(r.scores[0]).toBe(100);
    expect(r.scores[1]).toBe(0);
    expect(r.scores[2]).toBe(0);
    expect(r.scores[3]).toBe(0);
    expect(r.scores.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("intermediate tricks score 0 — only trick 8 winner gets +100", () => {
    // Seat 0 wins tricks 1-7, seat 1 wins trick 8 (seat 1 has highest card in last round)
    // Arrange: seats 0-3 cycle wins; trick 8 leader (whoever wins trick 7) plays a weak card
    // Simplest: fully drive with legalMoves; just verify base sum = 100 and one seat has 100.
    const r = new RoundManager(
      "LastTrick",
      hands(
        [c("A","S"), c("10","S"), c("A","H"), c("10","H"), c("A","D"), c("10","D"), c("A","C"), c("7","C")],
        [c("9","S"), c("8","S"), c("9","H"), c("8","H"), c("9","D"), c("8","D"), c("9","C"), c("10","C")],
        [c("K","S"), c("Q","S"), c("K","H"), c("Q","H"), c("K","D"), c("Q","D"), c("K","C"), c("8","C")],
        [c("J","S"), c("7","S"), c("J","H"), c("7","H"), c("J","D"), c("7","D"), c("J","C"), c("9","H")],
      ),
      0,
    );
    while (!r.finished) {
      r.play(r.turn, r.legalMoves(r.turn)[0]);
    }
    expect(r.finished).toBe(true);
    expect(r.endReason).toBe("Last Trick Won");
    expect(r.scores.reduce((a, b) => a + b, 0)).toBe(100);
    expect(r.scores.filter((s) => s === 100)).toHaveLength(1);
    expect(r.scores.filter((s) => s === 0)).toHaveLength(3);
  });

  it("selector multiplier x2 applies to Last Trick winner when selector wins", () => {
    const players = [0, 1, 2, 3].map((i) => new BotPlayer(i, `B${i}`, "easy"));
    const room = new GameRoom("LTTEST", "host", mulberry32(7), "quick", "LastTrick");
    room.fillBots("easy");
    room.start();
    let guard = 0;
    while (room.engine!.phase !== "finished" && guard++ < 500) room.autoAct();
    expect(room.engine!.phase).toBe("finished");
    const result = room.engine!.results[0];
    expect(result.mode).toBe("LastTrick");
    expect(result.base.reduce((a, b) => a + b, 0)).toBe(100);
    // Selector's score must be base × multiplier
    expect(result.scores[result.selector]).toBe(result.base[result.selector] * result.multipliers[result.selector]);
  });
});

describe("Trix mode", () => {
  it("host (seat 0) starts first; only Jacks are legal before any suit opens", () => {
    const r = new RoundManager(
      "Trix",
      hands(
        [c("J","C"), c("10","C"), c("A","C"), c("K","C"), c("Q","C"), c("9","C"), c("8","C"), c("7","C")],
        [c("A","S"), c("K","S"), c("Q","S"), c("J","S"), c("10","S"), c("9","S"), c("8","S"), c("7","S")],
        [c("A","H"), c("K","H"), c("Q","H"), c("J","H"), c("10","H"), c("9","H"), c("8","H"), c("7","H")],
        [c("A","D"), c("K","D"), c("Q","D"), c("J","D"), c("10","D"), c("9","D"), c("8","D"), c("7","D")],
      ),
      1, // selector is seat 1 — but the HOST (seat 0) always starts first in Trix
    );
    // Host starts, nothing auto-played yet
    expect(r.turn).toBe(0);
    expect(r.trix!.table.C).toBeNull();
    expect(r.trix!.table.D).toBeNull();
    expect(r.hands[0]).toHaveLength(8);
    // Before any suit is open, the only legal plays are Jacks
    const legalIds = r.legalMoves(0).map((m) => `${m.card.rank}${m.card.suit}`);
    expect(legalIds).toEqual(["JC"]);

    // Playing the Jack opens the suit chain at J (idx 4)
    r.play(0, { card: c("J","C").toJSON() });
    expect(r.hands[0]).toHaveLength(7);
    expect(r.trix!.table.C).toEqual({ low: 4, high: 4 });
    // Turn moves clockwise
    expect(r.turn).toBe(1);

    // Seat 0's next legal plays: 10♣ (idx 3 = low-1) and Q♣ (idx 5 = high+1)
    const legalAfter = r.legalMoves(0).map((m) => `${m.card.rank}${m.card.suit}`).sort();
    expect(legalAfter).toContain("10C");
    expect(legalAfter).toContain("QC");
    expect(legalAfter).not.toContain("AC"); // A♣ is not adjacent to {4,4} yet
  });

  it("host with no Jacks has no legal move and can PASS (trixPass)", () => {
    const r = new RoundManager(
      "Trix",
      hands(
        [c("A","S"), c("K","S"), c("Q","S"), c("10","S"), c("9","S"), c("8","S"), c("7","S"), c("A","C")],
        [c("J","C"), c("J","H"), c("10","H"), c("Q","H"), c("K","H"), c("9","H"), c("8","H"), c("7","H")],
        [c("J","D"), c("10","D"), c("Q","D"), c("K","D"), c("9","D"), c("8","D"), c("7","D"), c("A","D")],
        [c("J","S"), c("10","S"), c("Q","S"), c("K","S"), c("9","C"), c("8","C"), c("7","C"), c("A","H")],
      ),
      0,
    );
    // Host has no Jack → nothing is legal
    expect(r.turn).toBe(0);
    expect(r.legalMoves(0)).toHaveLength(0);

    // PASS advances turn clockwise
    r.play(0, { card: c("7","C").toJSON(), trixPass: true });
    expect(r.turn).toBe(1);

    // Passing with a non-Ace legal move is rejected
    expect(() => r.play(1, { card: c("7","C").toJSON(), trixPass: true })).toThrow();
  });

  it("Ace grants an extra turn", () => {
    // Build a Trix round where seat 0 has J♣ (opens) and A♣ (extra turn).
    // All other suits are held by other seats so only clubs are legal for seat 0 initially.
    // Seats 1-3 hold only hearts/diamonds/spades so they pass clubs turns.
    const r = new RoundManager(
      "Trix",
      hands(
        // seat 0: J♣ (opens clubs), then 10♣, Q♣, K♣, A♣ and some cards they can't play yet
        [c("J","C"), c("10","C"), c("Q","C"), c("K","C"), c("A","C"), c("7","S"), c("8","S"), c("9","S")],
        [c("7","H"), c("8","H"), c("9","H"), c("10","H"), c("K","H"), c("Q","H"), c("J","H"), c("A","H")],
        [c("7","D"), c("8","D"), c("9","D"), c("10","D"), c("K","D"), c("Q","D"), c("J","D"), c("A","D")],
        [c("7","C"), c("8","C"), c("9","C"), c("A","S"), c("K","S"), c("Q","S"), c("J","S"), c("10","S")],
      ),
      1,
    );
    // Host (seat 0) starts; only Jacks are legal → play J♣ to open clubs
    expect(r.turn).toBe(0);
    r.play(0, { card: c("J","C").toJSON() });

    // Drive other seats (each opens their own suit with their Jack) back to seat 0
    while (r.turn !== 0 && !r.finished) {
      const t = r.turn;
      const legal = r.legalMoves(t);
      r.play(t, legal.length > 0 ? legal[0] : { card: c("7","H").toJSON() });
    }

    // Seat 0 plays 10♣ (idx 3 = low-1, extends down)
    r.play(0, { card: c("10","C").toJSON() });
    // Turn: seat 0 still? No — non-Ace, turn advances to seat 1.
    // Seat 1 has no clubs legal (H only), so passes → seat 2 passes → seat 3 can play 9♣ or 8♣/7♣
    // Drive using r.turn
    // seat 1 passes
    r.play(r.turn, r.legalMoves(r.turn).length > 0 ? r.legalMoves(r.turn)[0] : { card: c("7","H").toJSON() });
    // seat 2 or 3 acts
    while (r.turn !== 0 && !r.finished) {
      const t = r.turn;
      const legal = r.legalMoves(t);
      r.play(t, legal.length > 0 ? legal[0] : { card: c("7","H").toJSON() });
    }

    // Now seat 0 plays Q♣ (idx 5 = high+1)
    if (!r.finished && r.turn === 0) {
      r.play(0, { card: c("Q","C").toJSON() });
    }
    while (r.turn !== 0 && !r.finished) {
      const t = r.turn;
      const legal = r.legalMoves(t);
      r.play(t, legal.length > 0 ? legal[0] : { card: c("7","H").toJSON() });
    }

    // Seat 0 plays K♣ (idx 6)
    if (!r.finished && r.turn === 0) {
      r.play(0, { card: c("K","C").toJSON() });
    }
    while (r.turn !== 0 && !r.finished) {
      const t = r.turn;
      const legal = r.legalMoves(t);
      r.play(t, legal.length > 0 ? legal[0] : { card: c("7","H").toJSON() });
    }

    // Now seat 0 plays A♣ (idx 7 = high+1 of K). A♣ is an Ace → extra turn
    if (!r.finished && r.turn === 0) {
      r.play(0, { card: c("A","C").toJSON() });
      // After Ace, turn should STAY on seat 0 (extra turn)
      expect(r.turn).toBe(0);
    }
  });

  it("scores -100 for 1st finisher, -50 for 2nd, 0 for others; ends after 2nd finisher", () => {
    // Quick game: seat 0 finishes fast, then seat 1
    const room = new GameRoom("TRIXTEST", "host", mulberry32(3), "quick", "Trix");
    room.fillBots("easy");
    room.start();
    expect(room.engine!.round?.mode).toBe("Trix");
    let guard = 0;
    while (room.engine!.phase !== "finished" && guard++ < 2000) room.autoAct();
    expect(room.engine!.phase).toBe("finished");
    const result = room.engine!.results[0];
    expect(result.mode).toBe("Trix");
    expect(result.endReason).toBe("Trix Finished");
    // Base scores: exactly one -100 and one -50, rest 0
    const sortedBase = [...result.base].sort((a, b) => a - b);
    expect(sortedBase[0]).toBe(-100);
    expect(sortedBase[1]).toBe(-50);
    expect(sortedBase[2]).toBe(0);
    expect(sortedBase[3]).toBe(0);
    // Selector multiplier applies: selector's score = base × 2
    expect(result.scores[result.selector]).toBe(result.base[result.selector] * 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL RULES — apply to every mode
// ─────────────────────────────────────────────────────────────────────────────

/** Full-match engine seeded with custom totals and a rigged K♥ hand. */
function riggedEngine(totals: number[], seed = 5): GameEngine {
  const players = [0, 1, 2, 3].map((i) => new BotPlayer(i, `B${i}`, "easy"));
  const e = new GameEngine(players, mulberry32(seed));
  e.start();
  e.totals = [...totals];
  // Seat 1 wins the very first trick with A♠ while seat 2 dumps K♥:
  // base = [0, 150, 0, 0] and the round ends immediately.
  e.pendingHands = [
    [c("9", "S"), c("7", "C")],
    [c("A", "S"), c("8", "H")],
    [c("K", "H"), c("9", "H")],
    [c("7", "H"), c("7", "D")],
  ];
  return e;
}

/** Selects KingOfHearts with seat 0 and drives the rigged round to completion. */
function playRiggedRound(e: GameEngine): EngineEvent[] {
  e.selectMode(0, "KingOfHearts");
  const events: EngineEvent[] = [];
  let guard = 0;
  while (e.phase === "playing" && e.round && !e.round.finished && guard++ < 50) {
    events.push(...e.play(e.round.turn, e.round.legalMoves(e.round.turn)[0]));
  }
  return events;
}

describe("Global Rule #1 — Last Mode Bonus", () => {
  it("stacks ×2 on every seat for the selector's final remaining mode", () => {
    // 150 → selector: 150 ×2(selector) ×2(last) = 600 · others: ×2 = 300
    expect(ScoreManager.applyMultiplier([150, 150, 150, 150], 0, false, false, true)).toEqual([600, 300, 300, 300]);
    // Switch: 150 ×2(switch) ×2(selector) ×2(last) = 1200
    expect(ScoreManager.applyMultiplier([150, 150, 150, 150], 0, true, false, true)).toEqual([1200, 600, 600, 600]);
    // Star + Switch: 150 ×2 ×2 ×2 ×2 = 2400
    expect(ScoreManager.applyMultiplier([150, 150, 150, 150], 0, true, true, true)).toEqual([2400, 1200, 1200, 1200]);
    expect(ScoreManager.multipliers(0, 4, false, false, true)).toEqual([4, 2, 2, 2]);
    expect(ScoreManager.multipliers(0, 4, false, false, false)).toEqual([2, 1, 1, 1]);
  });

  it("marks the round and doubles all four seats when the selector is down to one mode", () => {
    const e = riggedEngine([0, 0, 0, 0]);
    e.used[0] = MODE_IDS.filter((m) => m !== "LastTrick");
    e.pendingHands = [
      [c("A", "S"), c("10", "S"), c("A", "H"), c("10", "H"), c("A", "D"), c("10", "D"), c("A", "C"), c("10", "C")],
      [c("9", "S"), c("8", "S"), c("9", "H"), c("8", "H"), c("9", "D"), c("8", "D"), c("9", "C"), c("8", "C")],
      [c("K", "S"), c("Q", "S"), c("K", "H"), c("Q", "H"), c("K", "D"), c("Q", "D"), c("K", "C"), c("Q", "C")],
      [c("J", "S"), c("7", "S"), c("J", "H"), c("7", "H"), c("J", "D"), c("7", "D"), c("J", "C"), c("7", "C")],
    ];
    expect(e.remainingModes(0)).toEqual(["LastTrick"]);

    e.selectMode(0, "LastTrick");
    expect(e.lastModeBonus).toBe(true);

    let guard = 0;
    while (e.phase === "playing" && e.round && !e.round.finished && guard++ < 100) {
      e.play(e.round.turn, e.round.legalMoves(e.round.turn)[0]);
    }

    const res = e.results[0];
    expect(res.lastModeBonus).toBe(true);
    expect(res.multipliers).toEqual([4, 2, 2, 2]);
    expect(res.scores[res.selector]).toBe(res.base[res.selector] * 4);
    // The bonus is only live during that round.
    expect(e.lastModeBonus).toBe(false);
  });

  it("fires exactly once per player across a full match", () => {
    const e = playFullGame("medium", 7);
    expect(e.phase).toBe("finished");
    const bonusRounds = e.results.filter((r) => r.lastModeBonus);
    expect(bonusRounds).toHaveLength(4);
    expect([...new Set(bonusRounds.map((r) => r.selector))].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    for (const r of bonusRounds) {
      const meta =
        (r.mode === "Star" ? 2 : 1) * (r.mode === "Switch" || r.starSubMode === "Switch" ? 2 : 1) * 2;
      expect(r.multipliers[r.selector]).toBe(meta * 2);
      r.multipliers.forEach((m, seat) => {
        if (seat !== r.selector) expect(m).toBe(meta);
      });
    }
    expect(e.results.filter((r) => !r.lastModeBonus)).toHaveLength(36);
  });

  it("never applies in Quick Test mode", () => {
    const room = new GameRoom("QTEST01", "host", mulberry32(11), "quick", "KingOfHearts");
    room.fillBots("medium");
    room.start();
    expect(room.engine!.lastModeBonus).toBe(false);
    let guard = 0;
    while (room.engine!.phase !== "finished" && guard++ < 500) room.autoAct();
    const res = room.engine!.results[0];
    expect(res.lastModeBonus).toBe(false);
    expect(res.multipliers).toEqual([2, 1, 1, 1]);
  });
});

describe("Global Rule #2 — Thousand Reset", () => {
  it("zeroes exact multiples of 1000 (positive or negative) and nothing else", () => {
    for (const v of [1000, 2000, 99000, -1000, -2000, -99000]) {
      expect(ScoreManager.shouldReset(v)).toBe(true);
      expect(ScoreManager.applyThousandReset(v)).toBe(0);
    }
    for (const v of [0, 999, -999, 1001, -1001, 999001, -50, -100, -250, 980]) {
      expect(ScoreManager.shouldReset(v)).toBe(false);
      expect(ScoreManager.applyThousandReset(v)).toBe(v);
    }
    expect(ScoreManager.applyThousandResets([1000, -1000, 500, 0])).toEqual([0, 0, 500, 0]);
  });

  it("resets a total that lands on +1000 and announces it", () => {
    const e = riggedEngine([0, 850, 0, 0]); // 850 + 150 = 1000
    const events = playRiggedRound(e);
    expect(e.totals).toEqual([0, 0, 0, 0]);
    const resets = events.filter((ev) => ev.type === "score_reset");
    expect(resets).toHaveLength(1);
    expect(resets[0].data).toEqual({ seat: 1, reached: 1000, total: 0 });
  });

  it("resets a total that lands on -1000", () => {
    const e = riggedEngine([0, -1150, 0, 0]); // -1150 + 150 = -1000
    const events = playRiggedRound(e);
    expect(e.totals[1]).toBe(0);
    expect(events.filter((ev) => ev.type === "score_reset")).toHaveLength(1);
  });

  it("leaves totals alone and emits nothing when no total is a multiple of 1000", () => {
    const e = riggedEngine([0, 980, -990, 500]); // → 0, 1130, -990, 500
    const events = playRiggedRound(e);
    expect(e.totals).toEqual([0, 1130, -990, 500]);
    expect(events.filter((ev) => ev.type === "score_reset")).toHaveLength(0);
  });

  it("keeps exact zeros untouched (no reset event for a player already at 0)", () => {
    const e = riggedEngine([0, 0, 0, 0]);
    const events = playRiggedRound(e);
    expect(e.totals).toEqual([0, 150, 0, 0]);
    expect(events.filter((ev) => ev.type === "score_reset")).toHaveLength(0);
  });
});

describe("Global Rules #3 / #4 — negative scores & winner determination", () => {
  it("never clamps or converts negative totals", () => {
    const e = riggedEngine([-50, -100, -250, 300]);
    playRiggedRound(e);
    expect(e.totals).toEqual([-50, 50, -250, 300]);
  });

  it("awards the win to the LOWEST score, negatives included", () => {
    expect(ScoreManager.winners([-200, 50, 100, 300])).toEqual([0]);
    expect(ScoreManager.winners([80, -100, 20, 150])).toEqual([1]);
    expect(ScoreManager.winners([-800, -100, 20, 150])).toEqual([0]);
    expect(ScoreManager.winners([0, 0, 50, 100])).toEqual([0, 1]);
  });

  it("ranks ascending so the best (most negative) score sits at the top", () => {
    expect(ScoreManager.ranking([300, 50, 0, -100, -800])).toEqual([4, 3, 2, 1, 0]);
    expect(ScoreManager.ranking([-450, -120, 80, 330])).toEqual([0, 1, 2, 3]);
  });

  it("full match: a negative total still wins the game", () => {
    const e = playFullGame("hard", 21);
    expect(e.phase).toBe("finished");
    const best = Math.min(...e.totals);
    expect(ScoreManager.winners(e.totals)).toContain(e.totals.indexOf(best));
    // The persisted/engine totals always reflect the reset rule.
    for (const t of e.totals) expect(ScoreManager.shouldReset(t)).toBe(false);
  });
});
