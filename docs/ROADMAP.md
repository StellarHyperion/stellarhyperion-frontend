# What is not built yet

## Landed

- Next 16 app, strict TypeScript, and three gates that run before lint.
- The locked token plan as CSS custom properties: palette, both faces, the depth system, motion
  durations that collapse to zero under reduced motion.
- The mark, and a favicon set generated from the component's own geometry.
- The switchyard: four tracks, the winner drawn copper to blue, losers dotted with their reasons.
- Page chrome and the single column shell, with the landing page laid out as the route.

## Next, in this order

**Wallet connection.** Stellar Wallets Kit for the Stellar side and wagmi with viem for the EVM
side. Two wallets connected at once, because a transfer has two ends and asking somebody to
reconnect halfway is asking them to lose their place.

**Live quoting.** The protocol package already mirrors the router's quote ladder locally, in the
same order, so the app can price four rails while somebody is still typing without doing four
`eth_call`s per keystroke. The plan is to price locally as you type and confirm on chain before
anybody signs. Where the two disagree the chain is right.

**The transfer flow.** Stage lamps for the legs a rail actually has, which differ per rail: burn,
attest and mint on CCTP, a single hop on Allbridge. Named rather than numbered, because they are
not a sequence somebody is counting through.

**Claim settlement.** When a delivery cannot be handed over, the funds park as a claim anybody may
settle. The interface for that is small and it is the one screen somebody reaches on their worst
day, so it should be the clearest thing here.

**History**, driven by the backend's status API once that exists.

## The fixture, and when it goes

`src/app/_fixtures/yard.ts` supplies the switchyard with props so the page can be laid out. It is
not a data layer and it is not pretending to be: the file name says so, the header says so, and
the page says so under the deployment list. It exists because a component positioned with empty
props positions itself wrong and nobody finds out until real data arrives and the annotations
overlap.

It goes the moment live quoting lands, and nothing else should ever be added to that directory.

## Not planned

**A dashboard.** The rolled plan is a single column narrative scroll and the reason it beats a
split pane here is in the README. A dashboard is the default shape for anything with numbers in it
and the wrong shape for a linear journey across a boundary.

**A second copy of the quote arithmetic.** It lives in the protocol package, which both halves of
the product already import. Reimplementing it here would be a third place for it to drift.
