import { Card, Deck } from "./card";
import { Player } from "./players";
import { RoundManager } from "./round";
import { ScoreManager } from "./score";
import { ModeManager } from "./modes";
import { EngineEvent, GameType, MODE_IDS, ModeId, Move, StarState, SwitchState } from "@/types";

export type Phase =
  | "selecting"
  | "star_sub"
  | "switch_sub"
  | "switch_target"
  | "switch_reveal"
  | "playing"
  | "finished";

export interface RoundResult {
  number: number;
  mode: ModeId;
  selector: number;
  /** Human-readable reason the round ended (e.g. "King of Hearts Captured"). */
  endReason: string | null;
  /** Raw points before any multiplier. */
  base: number[];
  multipliers: number[];
  /** Final points (base × multipliers). */
  scores: number[];
  /** Global Rule #1 — true when the selector picked their final remaining mode (×2 for everyone). */
  lastModeBonus: boolean;
  generalBreakdown?: import("./modes").GeneralBreakdown[];
  round: RoundManager;
  /** Star: the sub-mode replayed under Star. */
  starSubMode?: ModeId;
  /** Switch: the underlying sub-mode (set when mode === "Switch" or starSubMode === "Switch"). */
  switchSubMode?: ModeId;
  /** Switch: swap pairs [[selectorSeat, targetSeat], [otherA, otherB]] */
  switchSwaps?: [[number, number], [number, number]];
}

export interface PlayerStats {
  modesWon: number;
  tricksWon: number;
  diamonds: number;
  queens: number;
  kingHearts: number;
  fiftyOneWins: number;
  turnsTricksWon: number;
  lastTrickWins: number;
  trixWins: number;
  switchWins: number;
  starWins: number;
}

export class GameEngine {
  phase: Phase = "selecting";
  readonly modes: ModeId[] = [...MODE_IDS];
  selector = 0;
  used: ModeId[][] = [[], [], [], []];
  totals: number[] = [0, 0, 0, 0];
  /** Global Rule #1 — set when the current round is the selector's final remaining mode. */
  lastModeBonus = false;
  roundNumber = 0;
  pendingHands: Card[][] = [];
  round: RoundManager | null = null;
  results: RoundResult[] = [];
  readonly gameType: GameType;
  readonly quickMode: ModeId | null;

  /** Active Star state — non-null for the whole duration of a Star round. */
  starState: StarState | null = null;
  /** Active Switch state — non-null during Switch selection / reveal flow (may be nested inside Star). */
  switchState: SwitchState | null = null;
  /** Countdown interval handle (set during Switch reveal countdown). */
  private revealTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly players: Player[],
    private rng: () => number = Math.random,
    gameType: GameType = "full",
    quickMode: ModeId | null = null,
  ) {
    if (players.length !== 4) throw new Error("Exactly 4 players required");
    this.gameType = gameType;
    this.quickMode = quickMode;
  }

  get totalRounds(): number {
    return this.gameType === "quick" ? 1 : this.players.length * this.modes.length;
  }

  remainingModes(seat: number): ModeId[] {
    if (this.gameType === "quick" && this.quickMode) {
      return this.used[seat].includes(this.quickMode) ? [] : [this.quickMode];
    }
    return this.modes.filter((m) => {
      if (this.used[seat].includes(m)) return false;
      if (m === "Switch" && !ModeManager.switchAvailable(this.used)) return false;
      if (m === "Star" && !ModeManager.starAvailable(this.used)) return false;
      return true;
    });
  }

  /** Shuffles and deals 8 cards each; for quick test, auto-selects mode immediately or waits for selector. */
  start(): EngineEvent[] {
    const events = this.deal();
    if (this.gameType === "quick" && this.quickMode && this.quickMode !== "Switch" && this.quickMode !== "Star") {
      events.push(...this.selectMode(this.selector, this.quickMode));
    }
    return events;
  }

  private deal(): EngineEvent[] {
    this.pendingHands = new Deck().shuffle(this.rng).deal(4, 8);
    this.phase = "selecting";
    this.round = null;
    this.starState = null;
    this.switchState = null;
    this.lastModeBonus = false;
    return [{ type: "deal_cards", data: { roundNumber: this.roundNumber + 1, selector: this.selector } }];
  }

  selectMode(seat: number, mode: ModeId): EngineEvent[] {
    if (this.phase !== "selecting") throw new Error("Not in selection phase");
    if (seat !== this.selector) throw new Error("You are not the selector");
    if (!this.remainingModes(seat).includes(mode)) throw new Error("Mode unavailable");

    // Global Rule #1 — Last Mode Bonus: picking the final remaining mode
    // doubles every seat's score for this round. Full matches only.
    this.lastModeBonus = this.gameType !== "quick" && this.remainingModes(seat).length === 1;

    if (mode === "Star") {
      if (!ModeManager.starAvailable(this.used)) {
        throw new Error("Star requires at least one completed mode");
      }
      this.used[seat].push(mode);
      this.roundNumber++;
      this.phase = "star_sub";
      this.starState = { subMode: null };
      return [{ type: "mode_selected", data: { seat, mode, roundNumber: this.roundNumber } }];
    }

    if (mode === "Switch") {
      if (!ModeManager.switchAvailable(this.used)) {
        throw new Error("Switch requires at least one completed mode");
      }
      this.used[seat].push(mode);
      this.roundNumber++;
      this.phase = "switch_sub";
      this.switchState = {
        phase: "sub_select",
        subMode: null,
        swapTarget: null,
        otherPair: null,
        preSwapHands: null,
        revealCountdown: 10,
      };
      return [{ type: "mode_selected", data: { seat, mode, roundNumber: this.roundNumber } }];
    }

    this.used[seat].push(mode);
    this.roundNumber++;
    this.round = new RoundManager(mode, this.pendingHands, seat);
    this.phase = "playing";
    return [{ type: "mode_selected", data: { seat, mode, roundNumber: this.roundNumber } }];
  }

  // ─── Star sub-mode selection ────────────────────────────────────────────────

  /**
   * Star Step 2: selector picks which already-completed mode to replay under Star.
   * The chosen mode may be Switch — in that case, we immediately transition to
   * switch_sub so the selector also picks the Switch sub-mode.
   */
  selectStarSubMode(seat: number, subMode: ModeId): EngineEvent[] {
    if (this.phase !== "star_sub") throw new Error("Not in Star sub-mode selection");
    if (seat !== this.selector) throw new Error("You are not the selector");
    if (subMode === "Star") throw new Error("Cannot select Star as the Star sub-mode");
    const completed = ModeManager.completedModesForStar(this.used);
    if (!completed.includes(subMode)) throw new Error("Mode has not been completed yet");

    this.starState!.subMode = subMode;
    const events: EngineEvent[] = [{ type: "star_sub_selected", data: { seat, subMode } }];

    if (subMode === "Switch") {
      // Star wrapping Switch: now go through the Switch multi-step flow
      this.phase = "switch_sub";
      this.switchState = {
        phase: "sub_select",
        subMode: null,
        swapTarget: null,
        otherPair: null,
        preSwapHands: null,
        revealCountdown: 10,
      };
    } else {
      // Plain sub-mode: start playing immediately
      this.round = new RoundManager(subMode, this.pendingHands, this.selector);
      this.phase = "playing";
    }
    return events;
  }

  // ─── Switch sub-mode / target / reveal ──────────────────────────────────────

  /**
   * Switch Step 2: selector picks which already-completed mode to replay under Switch.
   * (Also used when Switch is nested inside Star.)
   */
  selectSwitchSubMode(seat: number, subMode: ModeId): EngineEvent[] {
    if (this.phase !== "switch_sub") throw new Error("Not in Switch sub-mode selection");
    if (seat !== this.selector) throw new Error("You are not the selector");
    if (subMode === "Switch") throw new Error("Cannot select Switch as the Switch sub-mode");
    if (subMode === "Star") throw new Error("Cannot select Star as the Switch sub-mode");
    const completed = ModeManager.completedModes(this.used);
    if (!completed.includes(subMode)) throw new Error("Mode has not been completed yet");
    this.switchState!.subMode = subMode;
    this.phase = "switch_target";
    this.switchState!.phase = "target_select";
    return [{ type: "switch_sub_selected", data: { seat, subMode } }];
  }

  /** Switch Step 3: selector picks which player to swap hands with. */
  selectSwitchTarget(seat: number, target: number): EngineEvent[] {
    if (this.phase !== "switch_target") throw new Error("Not in Switch target selection");
    if (seat !== this.selector) throw new Error("You are not the selector");
    if (target === seat) throw new Error("Cannot swap with yourself");
    if (target < 0 || target > 3) throw new Error("Invalid target seat");

    const others = [0, 1, 2, 3].filter((s) => s !== seat && s !== target) as [number, number];
    this.switchState!.swapTarget = target;
    this.switchState!.otherPair = others;
    this.switchState!.preSwapHands = this.pendingHands.map((h) => h.map((c) => c.toJSON()));
    this.switchState!.phase = "reveal";
    this.phase = "switch_reveal";
    this.switchState!.revealCountdown = 10;

    return [
      {
        type: "switch_target_selected",
        data: {
          seat,
          target,
          otherPair: others,
          preSwapHands: this.switchState!.preSwapHands,
        },
      },
    ];
  }

  /**
   * Called every second during the reveal countdown.
   * When it hits 0, performs the swap and starts play.
   */
  tickRevealCountdown(): EngineEvent[] {
    if (this.phase !== "switch_reveal" || !this.switchState) return [];
    this.switchState.revealCountdown--;
    if (this.switchState.revealCountdown > 0) {
      return [{ type: "switch_countdown", data: { remaining: this.switchState.revealCountdown } }];
    }
    return this.executeSwapAndStart();
  }

  private executeSwapAndStart(): EngineEvent[] {
    const ss = this.switchState!;
    const selector = this.selector;
    const target = ss.swapTarget!;
    const [otherA, otherB] = ss.otherPair!;

    const tmp = this.pendingHands[selector];
    this.pendingHands[selector] = this.pendingHands[target];
    this.pendingHands[target] = tmp;

    const tmp2 = this.pendingHands[otherA];
    this.pendingHands[otherA] = this.pendingHands[otherB];
    this.pendingHands[otherB] = tmp2;

    const subMode = ss.subMode!;
    this.round = new RoundManager(subMode, this.pendingHands, selector);
    this.phase = "playing";
    ss.phase = "playing";

    return [
      {
        type: "switch_swap_complete",
        data: { selectorSwap: [selector, target], otherSwap: [otherA, otherB], subMode },
      },
    ];
  }

  // ─── Play ────────────────────────────────────────────────────────────────────

  play(seat: number, move: Move): EngineEvent[] {
    if (this.phase !== "playing" || !this.round) throw new Error("No round in progress");
    const events = this.round.play(seat, move);
    if (this.round.finished) events.push(...this.finishRound());
    return events;
  }

  // ─── Finish round ────────────────────────────────────────────────────────────

  private finishRound(): EngineEvent[] {
    const r = this.round!;
    const before = [...this.totals];
    const base = [...r.scores];

    const isStar = !!this.starState;
    const isSwitch = !!this.switchState;
    const isLastMode = this.lastModeBonus;
    const isCapot = r.endReason === "Capot" && r.mode !== "General";

    // Capot bypasses selector and all meta multipliers — fixed ±100 stand as-is.
    const multipliers = isCapot
      ? Array(this.players.length).fill(1)
      : ScoreManager.multipliers(this.selector, this.players.length, isSwitch, isStar, isLastMode);
    const finalScores = isCapot
      ? [...base]
      : ScoreManager.applyMultiplier(base, this.selector, isSwitch, isStar, isLastMode);

    // Global Rule #2 — Thousand Reset: an exact multiple of 1000 (≠ 0) wipes to 0.
    const totalsAfterRound = ScoreManager.add(this.totals, finalScores);
    const scoreResets: { seat: number; reached: number }[] = [];
    this.totals = totalsAfterRound.map((total, seat) => {
      const reset = ScoreManager.applyThousandReset(total);
      if (reset !== total) scoreResets.push({ seat, reached: total });
      return reset;
    });
    const endReason = r.endReason;

    // Determine the canonical result mode name
    let resultMode: ModeId;
    if (isStar) resultMode = "Star";
    else if (isSwitch) resultMode = "Switch";
    else resultMode = r.mode;

    const result: RoundResult = {
      number: this.roundNumber,
      mode: resultMode,
      selector: this.selector,
      endReason,
      base,
      multipliers,
      scores: finalScores,
      lastModeBonus: isLastMode,
      round: r,
      generalBreakdown: r.mode === "General" ? r.generalBreakdown.map((b) => ({ ...b })) : undefined,
    };

    if (isStar && this.starState) {
      result.starSubMode = this.starState.subMode ?? undefined;
    }
    if (isSwitch && this.switchState) {
      result.switchSubMode = this.switchState.subMode ?? undefined;
      const ss = this.switchState;
      if (ss.swapTarget !== null && ss.otherPair !== null) {
        result.switchSwaps = [[this.selector, ss.swapTarget], ss.otherPair];
      }
    }

    this.results.push(result);

    const events: EngineEvent[] = [
      {
        type: "round_finished",
        data: {
          roundNumber: this.roundNumber,
          mode: resultMode,
          selector: this.selector,
          endReason,
          base,
          multipliers,
          scores: finalScores,
          lastModeBonus: isLastMode,
          generalBreakdown: r.mode === "General" ? r.generalBreakdown : undefined,
          starSubMode: result.starSubMode,
          switchSubMode: result.switchSubMode,
          switchSwaps: result.switchSwaps,
        },
      },
      // Global Rule #2 — announce every reset so clients can celebrate it.
      ...scoreResets.map(({ seat, reached }) => ({
        type: "score_reset",
        data: { seat, reached, total: this.totals[seat] },
      })),
      { type: "score_updated", data: { totals: this.totals, deltas: this.totals.map((t, i) => t - before[i]) } },
    ];

    this.starState = null;
    this.switchState = null;
    // The bonus belongs to the round that just ended — clear it for the next
    // selection phase (deal() does the same, but the game can also end here).
    this.lastModeBonus = false;

    if (this.gameType === "quick" || this.roundNumber >= this.totalRounds) {
      this.phase = "finished";
      events.push({ type: "game_finished", data: { totals: this.totals, winners: ScoreManager.winners(this.totals) } });
      return events;
    }
    if (this.remainingModes(this.selector).length === 0) this.selector++;
    if (this.selector >= this.players.length) {
      this.phase = "finished";
      events.push({ type: "game_finished", data: { totals: this.totals, winners: ScoreManager.winners(this.totals) } });
    } else {
      events.push(...this.deal());
      this.round = r;
    }
    return events;
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  stats(): PlayerStats[] {
    const stats: PlayerStats[] = this.players.map(() => ({
      modesWon: 0, tricksWon: 0, diamonds: 0, queens: 0, kingHearts: 0,
      fiftyOneWins: 0, turnsTricksWon: 0, lastTrickWins: 0, trixWins: 0,
      switchWins: 0, starWins: 0,
    }));
    for (const res of this.results) {
      const min = Math.min(...res.scores);
      res.scores.forEach((s, seat) => { if (s === min) stats[seat].modesWon++; });

      // Resolve the actual card-playing mode for stat attribution
      const playMode = res.switchSubMode ?? res.starSubMode ?? res.mode;

      if (playMode === "FiftyOne") {
        res.base.forEach((b, seat) => { if (b > 0) stats[seat].fiftyOneWins++; });
        continue;
      }
      if (playMode === "Trix") {
        const trixFirst = res.round.trix?.finishOrder[0] ?? -1;
        if (trixFirst >= 0) stats[trixFirst].trixWins++;
        continue;
      }
      if (res.mode === "Switch") {
        const switchMin = Math.min(...res.scores);
        res.scores.forEach((s, seat) => { if (s === switchMin) stats[seat].switchWins++; });
      }
      if (res.mode === "Star") {
        const starMin = Math.min(...res.scores);
        res.scores.forEach((s, seat) => { if (s === starMin) stats[seat].starWins++; });
      }
      for (const t of res.round.completed) {
        stats[t.winner].tricksWon++;
        if (playMode === "Turns" || playMode === "General") stats[t.winner].turnsTricksWon++;
        for (const p of t.plays) {
          if ((playMode === "Diamonds" || playMode === "General") && p.card.suit === "D") stats[t.winner].diamonds++;
          if ((playMode === "Queens" || playMode === "General") && p.card.rank === "Q") stats[t.winner].queens++;
          if ((playMode === "KingOfHearts" || playMode === "General") && p.card.suit === "H" && p.card.rank === "K") stats[t.winner].kingHearts++;
        }
      }
      if ((playMode === "LastTrick" || playMode === "General") && res.round.completed.length === 8) {
        stats[res.round.completed[7].winner].lastTrickWins++;
      }
    }
    return stats;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  actor(): number | null {
    if (
      this.phase === "selecting" ||
      this.phase === "star_sub" ||
      this.phase === "switch_sub" ||
      this.phase === "switch_target"
    ) return this.selector;
    if (this.phase === "switch_reveal") return null;
    if (this.phase === "playing" && this.round && !this.round.finished) return this.round.turn;
    return null;
  }

  handOf(seat: number | null): Card[] {
    if (seat === null) return [];
    if (
      this.phase === "selecting" ||
      this.phase === "star_sub" ||
      this.phase === "switch_sub" ||
      this.phase === "switch_target" ||
      this.phase === "switch_reveal"
    ) return this.pendingHands[seat] ?? [];
    return this.round?.hands[seat] ?? [];
  }
}
