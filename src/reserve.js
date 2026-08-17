/**
 * Reserve accounting for a fully-reserved stablecoin.
 *
 * This file holds no keys and touches no network. It is the part that decides
 * how many tokens may exist, and it is deliberately separable so it can be
 * tested without a chain — see invariant-test.js.
 *
 * THE ONE RULE
 *
 *   circulating tokens x peg  <=  USD value actually held in reserve
 *
 * Everything else here exists to keep that true. A stablecoin is not a price
 * written in a config file; it is the promise that anyone holding one token can
 * hand it back and receive PEG dollars of real collateral. The moment that
 * promise cannot be met for every holder at once, the peg is arithmetic
 * fiction and the market prices it accordingly, usually within hours.
 *
 * ROUNDING
 *
 * Every division below truncates, and the direction is chosen so the truncated
 * remainder always stays with the reserve, never with the user. Minting rounds
 * tokens down; redeeming rounds lamports down. Rounding the other way leaks a
 * fraction of a cent per operation, and an attacker will happily run that loop
 * a million times. Integer math throughout for the same reason — floats drift,
 * and a drifting peg is a broken peg.
 */

export const DECIMALS = 6;
export const UNITS_PER_TOKEN = 10n ** BigInt(DECIMALS);
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Peg, in US cents. 150 = $1.50. Override with PEG_CENTS=42000 for $420.
 *
 * The number itself is arbitrary and carries no economics. It sets only how
 * much collateral each token requires, and the two move in lockstep:
 *
 *   $1.50 peg  ->    $15,000 backs 10,000 tokens
 *   $24.70 peg ->   $247,000 backs 10,000 tokens
 *   $420 peg   -> $4,200,000 backs 10,000 tokens
 *
 * Same reserve, same total value, different unit. Choosing $420 does not make
 * anyone richer; it makes each token a bigger claim on the same pile, so you
 * can issue proportionally fewer of them. It is a unit choice, like metres
 * versus feet.
 *
 * $1.00 is what every stablecoin that worked chose, for one reason: a holder
 * can tell at a glance whether the peg is holding. At $24.70 nobody can eyeball
 * whether $24.31 is a wobble or a collapse.
 */
export const PEG_CENTS = BigInt(process.env.PEG_CENTS ?? 150);

/* ── conversions ─────────────────────────────────────────────────────────── */

export function usdCentsOfLamports(lamports, solPriceCents) {
  return (BigInt(lamports) * BigInt(solPriceCents)) / LAMPORTS_PER_SOL;
}

export function lamportsForUsdCents(usdCents, solPriceCents) {
  return (BigInt(usdCents) * LAMPORTS_PER_SOL) / BigInt(solPriceCents);
}

/** Tokens (base units) mintable against a USD amount, at the peg. Rounds down. */
export function unitsForUsdCents(usdCents) {
  return (BigInt(usdCents) * UNITS_PER_TOKEN) / PEG_CENTS;
}

/** USD owed to redeem this many token base units, at the peg. Rounds up. */
export function usdCentsForUnits(units) {
  // Rounds UP: the reserve must be able to cover the full claim. Rounding down
  // here would let circulating supply quietly exceed what the reserve can pay.
  const n = BigInt(units) * PEG_CENTS;
  const d = UNITS_PER_TOKEN;
  return (n + d - 1n) / d;
}

/* ── reserve ─────────────────────────────────────────────────────────────── */

export class InsolventError extends Error {}
export class UnbackedMintError extends Error {}

export class Reserve {
  constructor() {
    this.reserveLamports = 0n;
    this.circulatingUnits = 0n;
  }

  reserveUsdCents(solPriceCents) {
    return usdCentsOfLamports(this.reserveLamports, solPriceCents);
  }

  /** USD owed if every holder redeemed right now. */
  liabilitiesUsdCents() {
    return usdCentsForUnits(this.circulatingUnits);
  }

  /** Assets / liabilities. 1.0 is exactly backed; below 1.0 the peg cannot be honoured. */
  collateralRatio(solPriceCents) {
    const liab = this.liabilitiesUsdCents();
    if (liab === 0n) return Infinity;
    return Number(this.reserveUsdCents(solPriceCents)) / Number(liab);
  }

  assertSolvent(solPriceCents) {
    const assets = this.reserveUsdCents(solPriceCents);
    const liab = this.liabilitiesUsdCents();
    if (assets < liab) {
      throw new InsolventError(
        `reserve ${assets}c cannot cover ${liab}c of claims ` +
          `(ratio ${this.collateralRatio(solPriceCents).toFixed(4)})`
      );
    }
  }

  /**
   * Take collateral, return how many token base units may be minted for it.
   * Never mints more than the deposit itself backs.
   */
  deposit(lamports, solPriceCents) {
    const usd = usdCentsOfLamports(lamports, solPriceCents);
    const units = unitsForUsdCents(usd);

    this.reserveLamports += BigInt(lamports);
    this.circulatingUnits += units;

    // Belt and braces. If this ever throws, the bug is in the maths above and
    // the correct response is to stop, not to mint anyway.
    this.assertSolvent(solPriceCents);
    return units;
  }

  /**
   * Burn tokens, return the lamports owed.
   * Refuses rather than paying out collateral that is not there.
   */
  redeem(units, solPriceCents) {
    units = BigInt(units);
    if (units > this.circulatingUnits) {
      throw new UnbackedMintError(
        `cannot redeem ${units} units; only ${this.circulatingUnits} in circulation`
      );
    }

    const usd = usdCentsForUnits(units);
    const lamports = lamportsForUsdCents(usd, solPriceCents);

    if (lamports > this.reserveLamports) {
      throw new InsolventError(
        `redemption needs ${lamports} lamports; reserve holds ${this.reserveLamports}. ` +
          `Collateral has fallen in value — this is the failure mode that breaks pegs.`
      );
    }

    this.reserveLamports -= lamports;
    this.circulatingUnits -= units;
    return lamports;
  }

  /**
   * Mint without matching collateral. This is what an algorithmic stablecoin
   * does, and it is the reason none of them have held. Present so the test
   * suite can demonstrate the failure rather than describe it.
   */
  mintUnbacked(units, solPriceCents) {
    this.circulatingUnits += BigInt(units);
    this.assertSolvent(solPriceCents); // throws, by design
  }
}

export const fmtUsd = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;
export const fmtTokens = (units) =>
  (Number(units) / Number(UNITS_PER_TOKEN)).toFixed(6);
export const fmtSol = (lamports) =>
  (Number(lamports) / Number(LAMPORTS_PER_SOL)).toFixed(9);
