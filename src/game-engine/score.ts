export const SELECTOR_MULTIPLIER = 2;
export const SWITCH_MULTIPLIER = 2;
export const STAR_MULTIPLIER = 2;
/** Global Rule #1 — the round in which a player selects their final remaining mode. */
export const LAST_MODE_MULTIPLIER = 2;
/** Global Rule #2 — landing exactly on ±1000/±2000/… collapses the total to 0. */
export const THOUSAND_RESET_MODULO = 1000;

export class ScoreManager {
  static add(totals: number[], roundScores: number[]): number[] {
    return totals.map((t, i) => t + (roundScores[i] ?? 0));
  }

  /**
   * Apply per-seat multipliers to base scores.
   *
   * Multiplier stacking order (all multiplicative):
   *   selector bonus: ×2 always (unless Capot)
   *   Switch bonus:   ×2 for ALL seats when inside a Switch round
   *   Star bonus:     ×2 for ALL seats when inside a Star round
   *   Last-mode bonus:×2 for ALL seats when the selector picked their final
   *                   remaining mode (global Rule #1, full matches only)
   *
   * Examples:
   *   Normal round, selector:       base × 2
   *   Switch round, non-selector:   base × 2   (switch)
   *   Switch round, selector:       base × 2 × 2 = ×4
   *   Star round, non-selector:     base × 2   (star)
   *   Star round, selector:         base × 2 × 2 = ×4
   *   Star(Switch) round, non-sel:  base × 2 × 2 = ×4   (switch × star)
   *   Star(Switch) round, selector: base × 2 × 2 × 2 = ×8
   *   Last-mode round, non-selector: base × 2           (last mode)
   *   Last-mode round, selector:     base × 2 × 2 = ×4
   */
  static applyMultiplier(
    base: number[],
    selector: number,
    isSwitch = false,
    isStar = false,
    isLastMode = false,
  ): number[] {
    const switchBonus = isSwitch ? SWITCH_MULTIPLIER : 1;
    const starBonus = isStar ? STAR_MULTIPLIER : 1;
    const lastModeBonus = isLastMode ? LAST_MODE_MULTIPLIER : 1;
    return base.map((score, seat) =>
      seat === selector
        ? score * SELECTOR_MULTIPLIER * switchBonus * starBonus * lastModeBonus
        : score * switchBonus * starBonus * lastModeBonus,
    );
  }

  static multipliers(
    selector: number,
    players = 4,
    isSwitch = false,
    isStar = false,
    isLastMode = false,
  ): number[] {
    const switchBonus = isSwitch ? SWITCH_MULTIPLIER : 1;
    const starBonus = isStar ? STAR_MULTIPLIER : 1;
    const lastModeBonus = isLastMode ? LAST_MODE_MULTIPLIER : 1;
    return Array.from({ length: players }, (_, seat) =>
      seat === selector
        ? SELECTOR_MULTIPLIER * switchBonus * starBonus * lastModeBonus
        : 1 * switchBonus * starBonus * lastModeBonus,
    );
  }

  /**
   * Global Rule #2 — Thousand Reset.
   * A total that lands on ±1000, ±2000, … (but never plain 0) is wiped to 0.
   * Works for negative values too (`-1000 % 1000` is `-0`, which `=== 0`).
   */
  static shouldReset(score: number): boolean {
    return score !== 0 && score % THOUSAND_RESET_MODULO === 0;
  }

  /** Returns the score after applying the Thousand Reset (0 when it triggers). */
  static applyThousandReset(score: number): number {
    return ScoreManager.shouldReset(score) ? 0 : score;
  }

  /** Applies the Thousand Reset to every total. Negative scores stay negative. */
  static applyThousandResets(totals: number[]): number[] {
    return totals.map((t) => ScoreManager.applyThousandReset(t));
  }

  /** LOWEST score wins. Ties produce several winners. Negative scores are lower than positive ones. */
  static winners(totals: number[]): number[] {
    const min = Math.min(...totals);
    return totals.flatMap((t, i) => (t === min ? [i] : []));
  }

  /** Seats sorted by ascending total (best first). */
  static ranking(totals: number[]): number[] {
    return totals.map((_, i) => i).sort((a, b) => totals[a] - totals[b] || a - b);
  }
}
