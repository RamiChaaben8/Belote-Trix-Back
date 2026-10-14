import { describe, expect, it } from "vitest";
import { Card, RoundManager } from "@/game-engine";
import { chooseMove, shouldPursueCapot } from "@/bots/ai";
import { Difficulty } from "@/types";

const c = (rank: string, suit: string) => new Card(suit as never, rank as never);
const hands = (...h: Card[][]) => h;
const THINKERS: Difficulty[] = ["medium", "hard"];

describe("Fifty One - 51 is a losing total", () => {
  it("disables Ace(+1) at 50 when PASS-like 9 is available", () => {
    const r = new RoundManager("FiftyOne", hands([c("A", "S"), c("9", "S")], [c("7", "H")], [c("7", "D")], [c("7", "C")]), 0);
    r.total = 50;
    const legal = r.legalMoves(0);
    expect(legal.some((m) => m.card.rank === "A")).toBe(false);
    expect(legal.map((m) => m.card.rank)).toEqual(["9"]);
  });

  it("disables A(+11) at 40 but allows K", () => {
    const r = new RoundManager("FiftyOne", hands([c("A", "S"), c("K", "S")], [c("7", "H")], [c("7", "D")], [c("7", "C")]), 0);
    r.total = 40;
    const legal = r.legalMoves(0);
    expect(legal.some((m) => m.card.rank === "A" && m.aceValue === 11)).toBe(false);
    expect(legal.some((m) => m.card.rank === "K")).toBe(true);
  });

  it("allows the losing card when it is the only one", () => {
    const r = new RoundManager("FiftyOne", hands([c("A", "S")], [c("7", "H")], [c("7", "D")], [c("7", "C")]), 0);
    r.total = 50;
    const legal = r.legalMoves(0);
    expect(legal).toHaveLength(1);
    r.play(0, legal[0]);
    expect(r.total).toBe(51);
    expect(r.scores[0]).toBe(510);
  });

  it("bots never pick a losing card when a safe one exists", () => {
    for (const d of ["easy", "medium", "hard"] as Difficulty[]) {
      const r = new RoundManager("FiftyOne", hands([c("A", "S"), c("9", "S")], [c("7", "H")], [c("7", "D")], [c("7", "C")]), 0);
      r.total = 50;
      expect(chooseMove(r, 0, d).card.rank).toBe("9");
    }
  });
});

describe("AI minimises score", () => {
  it("King of Hearts: avoids taking K♥ when it can play under", () => {
    for (const d of THINKERS) {
      const r = new RoundManager("KingOfHearts", hands([c("9", "H")], [c("K", "H"), c("7", "H")], [c("8", "S")], [c("7", "S")]), 0);
      r.play(0, { card: c("9", "H").toJSON() });
      expect(chooseMove(r, 1, d).card.rank).toBe("7");
    }
  });

  it("Queens: avoids winning a trick with a queen", () => {
    for (const d of THINKERS) {
      const r = new RoundManager("Queens", hands([c("9", "S")], [c("Q", "S"), c("7", "S")], [c("8", "S")], [c("7", "H")]), 0);
      r.play(0, { card: c("9", "S").toJSON() });
      expect(chooseMove(r, 1, d).card.rank).toBe("7");
    }
  });

  it("Diamonds: dumps a diamond on someone else instead of winning with it", () => {
    for (const d of THINKERS) {
      const r = new RoundManager("Diamonds", hands([c("A", "S")], [c("7", "D"), c("8", "C")], [c("8", "S")], [c("7", "S")]), 0);
      r.play(0, { card: c("A", "S").toJSON() });
      // void in spades: should discard the diamond (someone else wins the trick)
      expect(chooseMove(r, 1, d).card.suit).toBe("D");
    }
  });

  it("General score modes: prefers the lower total (loses the trick rather than winning it)", () => {
    for (const d of THINKERS) {
      const r = new RoundManager("Turns", hands([c("9", "S")], [c("A", "S"), c("7", "S")], [c("8", "S")], [c("7", "H")]), 0);
      r.play(0, { card: c("9", "S").toJSON() });
      expect(chooseMove(r, 1, d).card.rank).toBe("7");
    }
  });
});

describe("Capot strategy", () => {
  function capotRoundAfter(tricks: number): RoundManager {
    const r = new RoundManager(
      "Turns",
      hands(
        [c("A", "S"), c("10", "S"), c("A", "H"), c("10", "H"), c("A", "D"), c("10", "D"), c("A", "C"), c("10", "C")],
        [c("9", "S"), c("8", "S"), c("9", "H"), c("8", "H"), c("9", "D"), c("8", "D"), c("9", "C"), c("8", "C")],
        [c("K", "S"), c("Q", "S"), c("K", "H"), c("Q", "H"), c("K", "D"), c("Q", "D"), c("K", "C"), c("Q", "C")],
        [c("J", "S"), c("7", "S"), c("J", "H"), c("7", "H"), c("J", "D"), c("7", "D"), c("J", "C"), c("7", "C")],
      ),
      0,
    );
    for (let t = 0; t < tricks; t++) for (let s = 0; s < 4; s++) r.play(s, { card: r.hands[s][0].toJSON() });
    return r;
  }

  it("hard AI pursues Capot after winning 4 tricks; easy never does", () => {
    const r = capotRoundAfter(4);
    expect(shouldPursueCapot(r, 0, "hard")).toBe(true);
    expect(shouldPursueCapot(r, 0, "easy")).toBe(false);
    expect(shouldPursueCapot(r, 0, "medium")).toBe(false); // needs 5+ wins
  });

  it("medium AI considers Capot after 5 won tricks with strong cards", () => {
    const r = capotRoundAfter(5);
    expect(shouldPursueCapot(r, 0, "medium")).toBe(true);
  });

  it("hard AI completes the Capot", () => {
    const r = capotRoundAfter(4);
    for (let t = 0; t < 4; t++) {
      for (let s = 0; s < 4; s++) r.play(s, s === 0 ? chooseMove(r, s, "hard") : r.legalMoves(s)[0]);
    }
    expect(r.endReason).toBe("Capot");
    expect(r.scores[0]).toBe(-100);
  });
});

describe("Switch/Star Back button", () => {
  it("goes back exactly one step and keeps the chosen sub-mode", async () => {
    const { GameEngine, BotPlayer, mulberry32 } = await import("@/game-engine");
    const players = [0, 1, 2, 3].map((i) => new BotPlayer(i, `B${i}`, "easy"));
    const e = new GameEngine(players, mulberry32(3));
    e.start();
    e.used[0].push("General");
    e.selectMode(e.selector, "Switch");
    e.selectSwitchSubMode(e.selector, "General");
    expect(e.phase).toBe("switch_target");
    e.selectionBack(e.selector);
    expect(e.phase).toBe("switch_sub");
    expect(e.switchState!.subMode).toBe("General");
    e.selectionBack(e.selector);
    expect(e.phase).toBe("selecting");
    expect(e.used[e.selector]).not.toContain("Switch");
  });
});
