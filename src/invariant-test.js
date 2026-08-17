/**
 * Reserve invariant tests. No network, no keys, no install — plain node.
 *
 *   node src/invariant-test.js
 *
 * These are the tests that matter. A stablecoin does not fail because the
 * transfer instruction was wrong; it fails because supply drifted away from
 * collateral, one rounding error or one price move at a time.
 */

import {
  Reserve,
  InsolventError,
  LAMPORTS_PER_SOL,
  PEG_CENTS,
  fmtUsd,
  fmtTokens,
  fmtSol,
  unitsForUsdCents,
} from './reserve.js';

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
}

function throws(name, fn, ErrType) {
  try {
    fn();
    check(name, false, 'expected a throw, got none');
  } catch (e) {
    check(name, e instanceof ErrType, `threw ${e.constructor.name}: ${e.message}`);
  }
}

const SOL_200 = 20_000n; // $200.00 in cents
const SOL_100 = 10_000n; // $100.00

console.log(`\nPeg: ${fmtUsd(PEG_CENTS)} per token\n`);

/* ── 1. a deposit mints exactly what it backs ────────────────────────────── */
console.log('1. Deposit mints only what the collateral backs');
{
  const r = new Reserve();
  const minted = r.deposit(LAMPORTS_PER_SOL, SOL_200); // 1 SOL @ $200

  // $200 at a $1.50 peg = 133.333333 tokens (truncated).
  const expected = unitsForUsdCents(20_000n);
  check('1 SOL @ $200 mints 133.333333', minted === expected, fmtTokens(minted));
  check('reserve holds the deposit', r.reserveLamports === LAMPORTS_PER_SOL);
  check('solvent after mint', r.collateralRatio(SOL_200) >= 1.0,
    `ratio ${r.collateralRatio(SOL_200).toFixed(6)}`);
}

/* ── 2. round trip never creates or destroys value ───────────────────────── */
console.log('\n2. Deposit -> redeem round trip');
{
  const r = new Reserve();
  const minted = r.deposit(LAMPORTS_PER_SOL, SOL_200);
  const back = r.redeem(minted, SOL_200);

  check('all tokens burned', r.circulatingUnits === 0n);
  check('returns no more than deposited', back <= LAMPORTS_PER_SOL,
    `got ${fmtSol(back)} SOL`);
  check('reserve never goes negative', r.reserveLamports >= 0n,
    `dust left: ${r.reserveLamports} lamports`);
}

/* ── 3. rounding must always favour the reserve ──────────────────────────── */
console.log('\n3. Rounding leaks nothing over 2,000 cycles');
{
  const r = new Reserve();
  r.deposit(LAMPORTS_PER_SOL * 10n, SOL_200); // float the reserve

  const startLamports = r.reserveLamports;
  const startUnits = r.circulatingUnits;

  // Deliberately awkward amounts, chosen so every division truncates.
  for (let i = 1; i <= 2000; i++) {
    const odd = BigInt(1_000_003 + i * 7);
    const minted = r.deposit(odd, SOL_200);
    r.redeem(minted, SOL_200);
  }

  check('supply returns to where it started', r.circulatingUnits === startUnits,
    `drift: ${r.circulatingUnits - startUnits} units`);
  check('reserve did not shrink', r.reserveLamports >= startLamports,
    `delta: ${r.reserveLamports - startLamports} lamports`);
  check('still solvent', r.collateralRatio(SOL_200) >= 1.0);
}

/* ── 4. unbacked minting is rejected ─────────────────────────────────────── */
console.log('\n4. Minting without collateral is refused');
{
  const r = new Reserve();
  r.deposit(LAMPORTS_PER_SOL, SOL_200);

  throws('mintUnbacked throws InsolventError',
    () => r.mintUnbacked(1_000_000_000n, SOL_200), InsolventError);

  throws('redeeming more than exists throws',
    () => r.redeem(r.circulatingUnits + 1n, SOL_200), Error);
}

/* ── 5. the failure mode that actually kills pegs ────────────────────────── */
console.log('\n5. Collateral halves in value  (this is how pegs really die)');
{
  const r = new Reserve();
  const minted = r.deposit(LAMPORTS_PER_SOL, SOL_200); // backed at $200/SOL

  const before = r.collateralRatio(SOL_200);
  const after = r.collateralRatio(SOL_100); // SOL drops to $100

  check('fully backed at $200', before >= 1.0, `ratio ${before.toFixed(4)}`);
  check('under-collateralised at $100', after < 1.0, `ratio ${after.toFixed(4)}`);

  throws('redemption refused rather than paid from thin air',
    () => r.redeem(minted, SOL_100), InsolventError);

  console.log(`        note: nothing was minted wrongly here. The collateral simply`);
  console.log(`        became worth less than the promise written against it.`);
  console.log(`        Volatile collateral needs over-collateralisation; a stable`);
  console.log(`        reserve (USDC, T-bills) is why real issuers hold boring assets.`);
}

/* ── result ──────────────────────────────────────────────────────────────── */
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
