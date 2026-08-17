# yabbai-stablecoin

A fully-reserved stablecoin on Solana devnet. Every token in circulation is
backed by collateral actually held in the reserve, and the code refuses to mint
otherwise.

```bash
npm install
node src/invariant-test.js     # 14 tests, no network needed
node src/demo.js               # real devnet mint, needs a funded wallet
```

## The one rule

```
circulating tokens x peg  <=  USD value actually held in reserve
```

A stablecoin is not a price written in a config file. It is the promise that
anyone holding one token can hand it back and receive PEG dollars of real
collateral. The moment that promise cannot be met for every holder at once, the
peg is arithmetic fiction and the market prices it accordingly, usually within
hours.

`src/reserve.js` holds no keys and touches no network. It is the part that
decides how many tokens may exist, kept separable so it can be tested without a
chain.

## What the tests prove

```
node src/invariant-test.js
```

1. A deposit mints only what its collateral backs
2. Deposit → redeem round trips create and destroy nothing
3. 2,000 cycles of awkward amounts leak nothing to rounding
4. Minting without collateral is refused
5. Collateral halving in value breaks the peg — demonstrated, not described

Test 5 is the important one. Nothing is minted wrongly; the collateral simply
becomes worth less than the promise written against it. That is how pegs
actually die, and it is why real issuers hold boring assets.

## The peg is arbitrary

`PEG_CENTS` is configurable and tested at $1.50, $24.70 and $420.

```bash
PEG_CENTS=42000 node src/invariant-test.js
```

The number carries no economics. It sets only how much collateral each token
requires, and the two move in lockstep:

| peg | reserves for 10,000 tokens |
|---|---|
| $1.50 | $15,000 |
| $24.70 | $247,000 |
| $420.00 | $4,200,000 |

Same reserve, same total value, different unit. A higher peg does not make
anyone richer; it makes each token a larger claim on the same pile, so you issue
proportionally fewer. $1.00 is what every stablecoin that worked chose, because
a holder can tell at a glance whether the peg is holding.

## Rounding

Every division truncates toward the reserve. Minting rounds tokens down;
redeeming rounds the USD owed up. Rounding the other way leaks a fraction of a
cent per operation, and an attacker will happily run that loop a million times.
Integer and BigInt throughout — floats drift, and a drifting peg is a broken peg.

## What this is not

**The mint authority in `src/demo.js` is a keypair on disk.** The operator can
mint tokens no collateral backs. The reserve rule is enforced by this code
choosing to behave, and code can be edited.

That is the entire difference between this and a stablecoin. Making the rule real
requires the mint authority to be a Program Derived Address owned by an on-chain
program that checks the reserve inside the same transaction that mints — then
nobody can break it, including you, including someone who takes your keys.

That is step 2 and it needs Rust.

**Do not put anyone else's money into this version.**

## Keys

`src/demo.js` writes generated keypairs to `.keys/`, which is gitignored. Devnet
keys are worth nothing, but the layout is what a mainnet deployment would produce
and the habit matters. Git keeps deleted content forever — a key committed once
is compromised from that moment, regardless of the commit that removes it.

## Price data

SOL is priced from Jupiter, live. If the price cannot be read, the script prints
`DATA GAP` and exits rather than guessing — collateral valued by guesswork is not
collateral. Override for offline runs:

```bash
SOL_PRICE_CENTS=20000 node src/demo.js
```
