import { Card } from "./card";
import { BotPlayer, Player } from "./players";
import { GameEngine } from "./engine";
import { Difficulty, EngineEvent, GameType, ModeId, Move } from "@/types";
import { sortCards } from "./card";
import { ModeManager } from "./modes";

export interface ChatEntry {
  author: string;
  seat: number | null;
  content: string;
  at: number;
}

export type RoomStatus = "lobby" | "playing" | "finished";

/** A room holds seats, spectators, chat and (once started) the engine. Pure logic, no sockets. */
export class GameRoom {
  readonly seats: (Player | null)[] = [null, null, null, null];
  readonly spectators = new Map<string, string>();
  readonly chat: ChatEntry[] = [];
  engine: GameEngine | null = null;
  status: RoomStatus = "lobby";
  difficulty: Difficulty = "medium";
  gameType: GameType = "full";
  quickMode: ModeId = "KingOfHearts";
  readonly createdAt = Date.now();
  events: EngineEvent[] = [];
  timer: ReturnType<typeof setTimeout> | null = null;
  saved = false;
  /** Handle for the Switch reveal countdown interval. */
  revealInterval: ReturnType<typeof setInterval> | null = null;
  /** Deadline for the current connected human action, if one is active. */
  actionDeadline: number | null = null;
  actionDeadlineSeat: number | null = null;

  constructor(
    readonly code: string,
    public hostClientId: string,
    private rng: () => number = Math.random,
    gameType: GameType = "full",
    quickMode: ModeId = "KingOfHearts",
  ) {
    this.gameType = gameType;
    this.quickMode = quickMode;
  }

  seatOf(clientId: string): number | null {
    const i = this.seats.findIndex((p) => p?.clientId === clientId);
    return i === -1 ? null : i;
  }

  join(clientId: string, name: string, avatar: string): { seat: number | null; reconnected: boolean } {
    const existing = this.seatOf(clientId);
    if (existing !== null) {
      const p = this.seats[existing]!;
      p.connected = true;
      p.disconnectedAt = null;
      p.name = name || p.name;
      return { seat: existing, reconnected: true };
    }
    if (this.status === "lobby") {
      const free = this.seats.findIndex((p) => p === null);
      if (free !== -1) {
        this.seats[free] = new Player(free, name, false, clientId, avatar);
        this.spectators.delete(clientId);
        return { seat: free, reconnected: false };
      }
    }
    this.spectators.set(clientId, name);
    return { seat: null, reconnected: false };
  }

  leave(clientId: string): void {
    this.spectators.delete(clientId);
    const seat = this.seatOf(clientId);
    if (seat === null) return;
    if (this.status === "lobby") {
      this.seats[seat] = null;
      if (this.hostClientId === clientId) {
        const nextHost = this.seats.find((p) => p && !p.isBot);
        if (nextHost?.clientId) this.hostClientId = nextHost.clientId;
      }
    } else {
      const p = this.seats[seat]!;
      const bot = new BotPlayer(seat, p.name + " (bot)", this.difficulty);
      this.seats[seat] = bot;
      if (this.engine) this.engine.players[seat] = bot;
    }
  }

  setConnected(clientId: string, connected: boolean): number | null {
    const seat = this.seatOf(clientId);
    if (seat === null) return null;
    const p = this.seats[seat]!;
    p.connected = connected;
    p.disconnectedAt = connected ? null : Date.now();
    return seat;
  }

  addBot(difficulty: Difficulty = this.difficulty): number | null {
    if (this.status !== "lobby") return null;
    const free = this.seats.findIndex((p) => p === null);
    if (free === -1) return null;
    const names = ["Ava", "Noah", "Mia", "Leo", "Zoe", "Max", "Ivy", "Sam"];
    this.seats[free] = new BotPlayer(free, `${names[(free + this.code.length) % names.length]} 🤖`, difficulty);
    return free;
  }

  fillBots(difficulty: Difficulty = this.difficulty): void {
    while (this.addBot(difficulty) !== null) { /* keep filling */ }
  }

  removeBot(seat: number): void {
    if (this.status === "lobby" && this.seats[seat]?.isBot) this.seats[seat] = null;
  }

  get humanCount(): number {
    return this.seats.filter((p) => p && !p.isBot).length;
  }

  start(): EngineEvent[] {
    if (this.status !== "lobby") throw new Error("Game already started");
    if (this.seats.some((p) => p === null)) throw new Error("All four seats must be filled");
    this.engine = new GameEngine(this.seats as Player[], this.rng, this.gameType, this.gameType === "quick" ? this.quickMode : null);
    this.status = "playing";
    return this.engine.start();
  }

  selectMode(clientId: string, mode: ModeId): EngineEvent[] {
    const seat = this.requireSeat(clientId);
    return this.engine!.selectMode(seat, mode);
  }

  selectStarSubMode(clientId: string, subMode: ModeId): EngineEvent[] {
    const seat = this.requireSeat(clientId);
    return this.engine!.selectStarSubMode(seat, subMode);
  }

  selectSwitchSubMode(clientId: string, subMode: ModeId): EngineEvent[] {
    const seat = this.requireSeat(clientId);
    return this.engine!.selectSwitchSubMode(seat, subMode);
  }

  selectSwitchTarget(clientId: string, target: number): EngineEvent[] {
    const seat = this.requireSeat(clientId);
    return this.engine!.selectSwitchTarget(seat, target);
  }

  play(clientId: string, move: Move): EngineEvent[] {
    const seat = this.requireSeat(clientId);
    return this.engine!.play(seat, move);
  }

  private requireSeat(clientId: string): number {
    if (!this.engine) throw new Error("Game not started");
    const seat = this.seatOf(clientId);
    if (seat === null) throw new Error("You are not seated");
    return seat;
  }

  /** Executes one automatic action for a bot or an expired/disconnected human. */
  autoAct(): EngineEvent[] {
    const e = this.engine;
    if (!e) return [];

    // Star sub-mode selection
    if (e.phase === "star_sub" && e.selector !== null) {
      const seat = e.selector;
      const p = this.seats[seat]!;
      const isAuto = p.isBot || (!p.connected && p.disconnectedAt !== null) || this.deadlineExpired(seat);
      if (!isAuto) return [];
      const completed = ModeManager.completedModesForStar(e.used);
      if (completed.length === 0) return [];
      // Bots never pick Switch as the Star sub-mode (too complex)
      const pool = completed.filter((m) => m !== "Switch");
      const pick = pool.length > 0
        ? pool[Math.floor(this.rng() * pool.length)]
        : completed[Math.floor(this.rng() * completed.length)];
      return e.selectStarSubMode(seat, pick);
    }

    // Switch sub-mode selection (standalone or inside Star)
    if (e.phase === "switch_sub" && e.selector !== null) {
      const seat = e.selector;
      const p = this.seats[seat]!;
      const isAuto = p.isBot || (!p.connected && p.disconnectedAt !== null) || this.deadlineExpired(seat);
      if (!isAuto) return [];
      const completed = ModeManager.completedModes(e.used);
      if (completed.length === 0) return [];
      const pick = completed[Math.floor(this.rng() * completed.length)];
      return e.selectSwitchSubMode(seat, pick);
    }

    // Switch target selection
    if (e.phase === "switch_target" && e.selector !== null) {
      const seat = e.selector;
      const p = this.seats[seat]!;
      const isAuto = p.isBot || (!p.connected && p.disconnectedAt !== null) || this.deadlineExpired(seat);
      if (!isAuto) return [];
      const others = [0, 1, 2, 3].filter((s) => s !== seat);
      const target = others[Math.floor(this.rng() * others.length)];
      return e.selectSwitchTarget(seat, target);
    }

    // Switch reveal countdown — drain synchronously (no real timer in tests / bot rooms)
    if (e.phase === "switch_reveal") {
      const allEvents: EngineEvent[] = [];
      while (e.phase === "switch_reveal") {
        allEvents.push(...e.tickRevealCountdown());
      }
      return allEvents;
    }

    const seat = e.actor();
    if (seat === null) return [];
    const p = this.seats[seat]!;
    const bot = p instanceof BotPlayer ? p : new BotPlayer(seat, p.name, "medium");
    if (e.phase === "selecting") {
      const mode = bot.pickMode(e.remainingModes(seat), null, e.handOf(seat) as Card[], this.rng);
      return e.selectMode(seat, mode);
    }
    return e.play(seat, bot.pickMove(e.round!, this.rng));
  }

  actorIsAuto(graceMs: number): boolean {
    const e = this.engine;
    if (!e) return false;
    if (e.phase === "switch_reveal") return false;
    if (e.phase === "star_sub" || e.phase === "switch_sub" || e.phase === "switch_target") {
      const seat = e.selector;
      const p = this.seats[seat]!;
      if (p.isBot) return true;
      if (p.connected && this.deadlineExpired(seat)) return true;
      return !p.connected && p.disconnectedAt !== null && Date.now() - p.disconnectedAt >= graceMs;
    }

    const seat = e.actor();
    if (seat === null) return false;
    const p = this.seats[seat]!;
    if (p.isBot) return true;
    if (p.connected && this.deadlineExpired(seat)) return true;
    return !p.connected && p.disconnectedAt !== null && Date.now() - p.disconnectedAt >= graceMs;
  }

  private deadlineExpired(seat: number): boolean {
    return this.actionDeadline !== null &&
      this.actionDeadlineSeat === seat &&
      Date.now() >= this.actionDeadline;
  }

  finish(): void {
    this.status = "finished";
    this.actionDeadline = null;
    this.actionDeadlineSeat = null;
    if (this.revealInterval) {
      clearInterval(this.revealInterval);
      this.revealInterval = null;
    }
  }

  addChat(author: string, seat: number | null, content: string): ChatEntry {
    const entry = { author, seat, content: content.slice(0, 300), at: Date.now() };
    this.chat.push(entry);
    if (this.chat.length > 200) this.chat.shift();
    return entry;
  }

  /** Serialises the room for a particular viewer. Opponents' hands are never exposed. */
  view(clientId: string) {
    const e = this.engine;
    const seat = this.seatOf(clientId);
    const r = e?.round ?? null;
    const inMetaPhase =
      e?.phase === "selecting" ||
      e?.phase === "star_sub" ||
      e?.phase === "switch_sub" ||
      e?.phase === "switch_target" ||
      e?.phase === "switch_reveal";
    const showRound = !!r && (e!.phase === "playing" || inMetaPhase);
    const hand = e && seat !== null ? [...e.handOf(seat)].sort(sortCards) : [];
    const legal = e && seat !== null && e.phase === "playing" && r && !r.finished && r.turn === seat
      ? r.legalMoves(seat)
      : [];

    // Star view
    const starState = e?.starState ?? null;
    const starView = starState
      ? {
          subMode: starState.subMode,
          completedModes: ModeManager.completedModesForStar(e!.used),
        }
      : null;

    // Switch view (may be nested inside Star)
    const ss = e?.switchState ?? null;
    const completedModes = e ? ModeManager.completedModes(e.used) : [];
    const switchView = ss
      ? {
          phase: ss.phase,
          subMode: ss.subMode,
          swapTarget: ss.swapTarget,
          otherPair: ss.otherPair,
          revealCountdown: ss.revealCountdown,
          preSwapHands: ss.preSwapHands,
          currentHand: seat !== null && ss.preSwapHands ? ss.preSwapHands[seat] : null,
        }
      : null;

    return {
      code: this.code,
      status: this.status,
      host: this.hostClientId,
      isHost: this.hostClientId === clientId,
      difficulty: this.difficulty,
      gameType: this.gameType,
      quickMode: this.quickMode,
      you: seat,
      seats: this.seats.map((p, i) =>
        p
          ? { seat: i, name: p.name, isBot: p.isBot, connected: p.connected, avatar: p.avatar, isHost: p.clientId === this.hostClientId }
          : null,
      ),
      spectators: this.spectators.size,
      phase: e?.phase ?? "lobby",
      selector: e?.selector ?? null,
      used: e?.used ?? [[], [], [], []],
      modes: e?.modes ?? [],
      lastModeBonus: e?.lastModeBonus ?? false,
      remaining: e && seat !== null ? e.remainingModes(seat) : [],
      completedModes,
      roundNumber: e?.roundNumber ?? 0,
      totalRounds: e?.totalRounds ?? 40,
      totals: e?.totals ?? [0, 0, 0, 0],
      actor: e?.actor() ?? null,
      hand,
      legal,
      handCounts: e
        ? [0, 1, 2, 3].map(() =>
            inMetaPhase ? 8 : r ? r.hands[0].length : 8,
          )
        : [0, 0, 0, 0],
      dealer: e ? (e.roundNumber > 0 ? (e.roundNumber - 1) % 4 : 0) : null,
      leader: r ? r.leader : null,
      stats: e ? e.stats() : null,
      starState: starView,
      switchState: switchView,
      actionDeadline: this.actionDeadline,
      round:
        showRound && e!.phase === "playing"
          ? {
              mode: r!.mode,
              trick: r!.trick,
              broken: r!.broken,
              scores: r!.scores,
              total: r!.total,
              direction: r!.direction,
              tricks: r!.completed.map((t) => ({ index: t.index, winner: t.winner, points: t.points, plays: t.plays })),
              fiftyMoves: r!.mode === "FiftyOne"
                ? r!.plays.slice(-10).map((p) => ({
                    seat: p.seat,
                    card: p.card,
                    delta: p.total !== undefined ? (p.total - (r!.plays[p.seq - 1]?.total ?? 0)) : 0,
                    prevTotal: p.total !== undefined ? (r!.plays[p.seq - 1]?.total ?? 0) : 0,
                    newTotal: p.total ?? 0,
                    aceValue: p.aceValue ?? null,
                  }))
                : undefined,
              trixTable: r!.mode === "Trix" ? r!.trix?.table ?? null : null,
              trixFinishOrder: r!.mode === "Trix" ? (r!.trix?.finishOrder ?? []) : [],
              generalBreakdown: r!.mode === "General" ? r!.generalBreakdown : undefined,
            }
          : null,
      history: (e?.results ?? []).map((x) => ({
        number: x.number,
        mode: x.mode,
        selector: x.selector,
        endReason: x.endReason,
        base: x.base,
        multipliers: x.multipliers,
        scores: x.scores,
        lastModeBonus: x.lastModeBonus,
        generalBreakdown: x.generalBreakdown,
        starSubMode: x.starSubMode,
        switchSubMode: x.switchSubMode,
        switchSwaps: x.switchSwaps,
      })),
      lastRoundResult: e?.results.length
        ? (() => {
            const x = e.results[e.results.length - 1];
            return {
              number: x.number,
              mode: x.mode,
              selector: x.selector,
              endReason: x.endReason,
              base: x.base,
              multipliers: x.multipliers,
              scores: x.scores,
              lastModeBonus: x.lastModeBonus,
              starSubMode: x.starSubMode,
              switchSubMode: x.switchSubMode,
              switchSwaps: x.switchSwaps,
            };
          })()
        : null,
      chat: this.chat.slice(-50),
    };
  }
}
