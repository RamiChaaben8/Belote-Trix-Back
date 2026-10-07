import { chooseMode, chooseMove } from "@/bots/ai";
import { RoundManager } from "./round";
import { Difficulty, ModeId, Move } from "@/types";

export class Player {
  connected = true;
  disconnectedAt: number | null = null;
  constructor(
    public seat: number,
    public name: string,
    public isBot = false,
    public clientId: string | null = null,
    // Account link removed — guest-only build (players are never users).
    // public userId: string | null = null,
    public avatar = "🙂",
  ) {}
}

export class BotPlayer extends Player {
  constructor(
    seat: number,
    name: string,
    public difficulty: Difficulty,
  ) {
    super(seat, name, true, null, "🤖");
  }

  pickMove(round: RoundManager, rng: () => number = Math.random): Move {
    return chooseMove(round, this.seat, this.difficulty, rng);
  }

  pickMode(remaining: ModeId[], round: RoundManager | null, hand: import("./card").Card[], rng: () => number = Math.random): ModeId {
    // Bots never pick Switch or Star autonomously — both require multi-step human interaction.
    // Filter them out unless they are the only option remaining.
    const withoutMeta = remaining.filter((m) => m !== "Switch" && m !== "Star");
    const pool = withoutMeta.length > 0 ? withoutMeta : remaining;
    return chooseMode(pool, hand, this.difficulty, rng);
  }
}
