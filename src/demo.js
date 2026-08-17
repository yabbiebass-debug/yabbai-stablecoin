/**
 * yUSD on Solana devnet — a real SPL mint whose supply is governed by a real
 * reserve.
 *
 *   node src/demo.js
 *
 * Devnet SOL has no value, so every number here is honest without anyone
 * risking anything. The instructions are identical on mainnet; only the RPC
 * URL differs.
 *
 * WHAT THIS IS NOT
 *
 * The mint authority here is a keypair on this machine. That means the
 * operator — you — can mint tokens that no collateral backs. The reserve rule
 * in reserve.js is enforced by this script's own good behaviour, and a script
 * can be edited.
 *
 * That is the entire difference between this and a stablecoin. To make the
 * rule real, the mint authority has to be a Program Derived Address owned by
 * an on-chain program that checks the reserve inside the same transaction that
 * mints. Then nobody can break the rule, including you, including someone who
 * takes your keys. That is step 2 and it needs Rust.
 *
 * Do not put anyone else's money into this version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL as WEB3_LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl,
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  burn,
  getAccount,
} from '@solana/spl-token';

import { Reserve, DECIMALS, PEG_CENTS, fmtUsd, fmtTokens, fmtSol } from './reserve.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYDIR = path.join(HERE, '..', '.keys');
const WSOL = 'So11111111111111111111111111111111111111112';

const log = (...a) => console.log(...a);
const rule = () => log('-'.repeat(66));
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

/* ── keys ────────────────────────────────────────────────────────────────── */

function loadOrCreate(name) {
  fs.mkdirSync(KEYDIR, { recursive: true });
  const file = path.join(KEYDIR, `${name}.json`);
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

/* ── price ───────────────────────────────────────────────────────────────── */

/**
 * Real SOL price, or nothing. Following the house rule from the command app:
 * a value that cannot be read is reported as a gap, never estimated. A
 * stablecoin that guesses its collateral price is not backed, it is hoping.
 */
async function solPriceCents() {
  const override = process.env.SOL_PRICE_CENTS;
  if (override) {
    log(`price      : ${fmtUsd(BigInt(override))} / SOL   (SOL_PRICE_CENTS override)`);
    return BigInt(override);
  }
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const usd = json?.[WSOL]?.usdPrice ?? json?.data?.[WSOL]?.price;
    if (!usd) throw new Error('no price field in response');
    const cents = BigInt(Math.round(Number(usd) * 100));
    log(`price      : ${fmtUsd(cents)} / SOL   (Jupiter, live)`);
    return cents;
  } catch (e) {
    log(`\nDATA GAP: could not read a SOL price (${e.message}).`);
    log('Refusing to invent one — collateral valued by guesswork is not collateral.');
    log('Re-run with an explicit price, e.g.:  SOL_PRICE_CENTS=20000 node src/demo.js\n');
    process.exit(1);
  }
}

/* ── main ────────────────────────────────────────────────────────────────── */

async function main() {
  log('');
  log('yUSD — fully-reserved stablecoin on Solana devnet');
  rule();
  log(`peg        : ${fmtUsd(PEG_CENTS)} per token`);
  log(`decimals   : ${DECIMALS}`);

  const price = await solPriceCents();

  const connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
  const operator = loadOrCreate('operator');
  const reserveAcct = loadOrCreate('reserve');

  log(`operator   : ${operator.publicKey.toBase58()}`);
  log(`reserve    : ${reserveAcct.publicKey.toBase58()}`);
  rule();

  /* funding ---------------------------------------------------------------- */

  let balance = await connection.getBalance(operator.publicKey);
  if (balance < 0.5 * WEB3_LAMPORTS_PER_SOL) {
    log('funding operator from the devnet faucet...');
    try {
      const sig = await connection.requestAirdrop(operator.publicKey, 2 * WEB3_LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      balance = await connection.getBalance(operator.publicKey);
      log(`airdrop ok : ${explorer(sig)}`);
    } catch (e) {
      log(`\nairdrop refused: ${e.message}`);
      log('The devnet faucet rate-limits hard. Either wait, or fund this address at');
      log(`https://faucet.solana.com  ->  ${operator.publicKey.toBase58()}\n`);
      process.exit(1);
    }
  }
  log(`balance    : ${fmtSol(BigInt(balance))} SOL`);

  /* mint ------------------------------------------------------------------- */

  log('\ncreating SPL mint...');
  const mint = await createMint(
    connection,
    operator,
    operator.publicKey, // mint authority  <- a keypair. See the header note.
    operator.publicKey, // freeze authority
    DECIMALS
  );
  log(`mint       : ${mint.toBase58()}`);

  const ata = await getOrCreateAssociatedTokenAccount(
    connection, operator, mint, operator.publicKey
  );
  log(`token acct : ${ata.address.toBase58()}`);

  /* deposit + mint --------------------------------------------------------- */

  const reserve = new Reserve();
  const depositLamports = BigInt(Math.floor(0.25 * WEB3_LAMPORTS_PER_SOL));

  rule();
  log(`DEPOSIT ${fmtSol(depositLamports)} SOL into reserve`);

  const transferSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: reserveAcct.publicKey,
        lamports: Number(depositLamports),
      })
    ),
    [operator]
  );
  log(`transfer   : ${explorer(transferSig)}`);

  // The reserve decides how many tokens this backs. Nothing else does.
  const units = reserve.deposit(depositLamports, price);
  log(`backing    : ${fmtUsd(reserve.reserveUsdCents(price))}`);
  log(`mintable   : ${fmtTokens(units)} yUSD  at ${fmtUsd(PEG_CENTS)}`);

  const mintSig = await mintTo(
    connection, operator, mint, ata.address, operator, units
  );
  log(`minted     : ${explorer(mintSig)}`);

  let onChain = await getAccount(connection, ata.address);
  log(`on-chain   : ${fmtTokens(onChain.amount)} yUSD`);
  log(`ratio      : ${reserve.collateralRatio(price).toFixed(6)}  (1.0 = exactly backed)`);

  /* redeem ----------------------------------------------------------------- */

  const redeemUnits = units / 2n;
  rule();
  log(`REDEEM ${fmtTokens(redeemUnits)} yUSD`);

  const owed = reserve.redeem(redeemUnits, price);
  log(`owed       : ${fmtSol(owed)} SOL`);

  const burnSig = await burn(
    connection, operator, ata.address, mint, operator, redeemUnits
  );
  log(`burned     : ${explorer(burnSig)}`);

  const payoutSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: reserveAcct.publicKey,
        toPubkey: operator.publicKey,
        lamports: Number(owed),
      })
    ),
    [reserveAcct]
  );
  log(`paid out   : ${explorer(payoutSig)}`);

  onChain = await getAccount(connection, ata.address);

  rule();
  log('FINAL');
  log(`circulating: ${fmtTokens(onChain.amount)} yUSD`);
  log(`reserve    : ${fmtSol(reserve.reserveLamports)} SOL  = ${fmtUsd(reserve.reserveUsdCents(price))}`);
  log(`liabilities: ${fmtUsd(reserve.liabilitiesUsdCents())}`);
  log(`ratio      : ${reserve.collateralRatio(price).toFixed(6)}`);

  const agrees = BigInt(onChain.amount) === reserve.circulatingUnits;
  log(`\nledger vs chain: ${agrees ? 'AGREE' : 'DISAGREE — investigate before doing anything else'}`);
  reserve.assertSolvent(price);
  log('solvency check: PASS');
  log(`\nmint on explorer: https://explorer.solana.com/address/${mint.toBase58()}?cluster=devnet\n`);
}

main().catch((e) => {
  console.error(`\nfailed: ${e.message}\n`);
  process.exit(1);
});
