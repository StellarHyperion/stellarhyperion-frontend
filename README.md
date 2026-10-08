# Hyperion app

The front end for a router that moves money between Stellar and the EVM chains.

The product's claim is narrow and specific: Hyperion never decides for itself that a cross-chain
message is real. It prices four rails that already made that decision and were audited for it,
takes the one that lands the most money, and tells you what the other three would have cost. The
whole design of this app exists to make that claim checkable rather than just stated, which is why
the centrepiece is a diagram of four rails with the losers still drawn and their reasons attached.

## The design is a set of decisions, not a theme

Five axes were rolled once, before any code, and locked. The plan lives at
`.planning/DESIGN-TOKENS.md` in the project directory, outside this repository, and it is not
re-rolled. What follows is each roll and why it survived contact with the subject matter.

**Two hues, and they mean something.** Deep ink, copper, and a cold instrument blue. A bridge has
exactly two halves. Copper is the leg you control: Stellar, where a ledger closes every five
seconds and finality means finality. Instrument blue is the leg you wait on. The copper to blue
gradient on the winning track in the switchyard is the transfer, and the crossing point is where
custody stops being yours. The palette encodes the product rather than decorating it.

**One column, read top to bottom.** A transfer is a linear journey across a boundary, so the page's
vertical axis is the journey: origin leg, switchyard, destination leg. The coloured rule down the
left of each leg is that leg's own hue, and the yard in between is where one becomes the other, so
scrolling the page is following the money. Nothing is in a sidebar, because nothing about a
transfer happens beside it. This is also the roll that rejects the dashboard reflex, which is the
default shape for anything with numbers in it and the wrong shape for this.

**Monospace is the working face, not code decoration.** Archivo for display and prose, IBM Plex
Mono for every amount, address, nonce, chain id, ledger sequence, status word and label. Almost
every fact in a bridge interface is a number or an identifier, so making mono the label and data
face gives the whole thing instrument panel character with no illustration budget at all.

**Motion only ever means a state changed.** The switchyard's winning track draws itself when a
quote resolves. That is close to all of it. No scroll reveals, no fade and slide on every section,
no ambient pulse, no lift on hover. In a product where money moves, motion that does not mean
"something changed" is a lie about whether anything did. `prefers-reduced-motion` collapses every
duration to zero, so a transition becomes an instant state swap rather than a fast one, which is
the right collapse: a faster version of a thing somebody asked not to see is not a compromise.

**One structural device: the switchyard.** A live SVG interchange. Four tracks fan out of an origin
node, run parallel, and converge on a destination node. When a quote resolves the winning track
draws itself copper to blue; the losers stay one pixel and dotted, each carrying a mono annotation
of why it lost. It is the only place in the build spending its budget on a picture and it earns it
by turning the architecture's central claim into something somebody can inspect.

Deliberately absent, because they are the tells: all caps tracked eyebrow labels, em dash label
fragments, arrows glued to the end of every link, decorative 01 / 02 / 03 markers, and the card kit
of identical radii over identical soft grey shadows. There is **not one box shadow in this
repository** and a check fails the build if one appears. Depth comes from one pixel hairlines and a
background step, and the radius varies by role: four pixels on a data panel, two on a control, zero
on the switchyard because it is not a card and should not look like the biggest one.

## Three checks that run before lint

`npm run check` is format, house rules, contrast, lint, typecheck, build. The middle two are
specific to this repository.

**`npm run house`** reads every tracked file and fails on: an em or en dash anywhere, an emoji or a
glyph arrow, a word from a banned vocabulary list, a box shadow, or a hex colour outside the token
layer. The dash rule is the one that earns its keep. It is easy to agree not to use em dashes and
very hard to actually not, and a checker that reads the whole tree is the only version of that
agreement which holds. The script skips itself for the text rules, because a checker cannot contain
the text it checks for, and it writes its own patterns as escapes so the repository holds zero
literal em or en dash bytes.

The hex rule has one declared exception and it is checked rather than waived. `src/app/tokens.ts`
holds literals for the `theme-color` meta tag and the favicon generator, and every one of them has
to also appear in `globals.css`. A generated SVG favicon has to carry literal colour, because it is
loaded as an image outside the document and has no access to a custom property, so every hex in it
has to appear in the token layer that produced it. A hand edit to the tab icon is caught.

**`npm run contrast`** computes the real ratio for forty nine role and surface pairs and fails any
that falls under its bar, 4.5 for text and 3.0 for a graphic or a focus ring. A dark palette with
a copper accent is exactly the kind that looks fine and fails, and the check is cheaper than
finding out from somebody who cannot read it.

## The mark

A monoline switch. A line comes in from the left, reaches a solid junction node and forks. One
branch leaves to the right and keeps going; the other peels off at the same angle and stops short,
because it was priced and it lost.

That is the product in nineteen points of geometry. A mark showing a bridge would be claiming
something the architecture explicitly does not do. Legibility at sixteen pixels comes from the
difference in branch length rather than a difference in stroke weight, because a hairline at that
size is a grey smudge and a shorter line is still a shorter line.

`npm run icons` generates the favicon set by reading the path data and the node circle out of the
component itself, and fails loudly if it cannot find them. So the tab icon cannot drift away from
the mark in the header, which is the usual way those two end up disagreeing.

## Accessibility

The switchyard drawing is `aria-hidden` and the table underneath it is not. A four track
interchange described through an alt string produces a sentence nobody wants to hear; the table
carries the same facts in the same order and is the primary representation for a screen reader
rather than a fallback. Below forty eight rem the drawing is removed rather than squeezed, because
four tracks in a phone's width is four parallel lines nobody can tell apart, and the table was
always the better artifact at that size.

Everything interactive has a visible focus state in copper, verified against every surface it can
sit on. Reduced motion is honoured by collapsing durations to zero rather than by shortening them.

## Running it

```bash
# The shared SDK is a file dependency on the contracts repo and has to be built first.
cd ../contracts/packages/protocol && npm install && npm run build && cd -

npm install
npm run dev
npm run check      # format, house rules, contrast, lint, typecheck, production build
```

One trap worth knowing, and it is written at length in `next.config.ts`. Turbopack will not follow
a symlink out of its root. `@hyperion/protocol` is a `file:` dependency on a sibling repository, so
npm installs it as a symlink resolving outside this directory, and pinning `turbopack.root` to this
package makes the shared SDK unresolvable with a bare "module not found" that says nothing about
symlinks. The root is the directory holding both repositories, which is what a workspace root
means.

## Implemented capabilities

1. **Dual wallet connectivity**: Stellar Wallets Kit for Soroban accounts (Freighter, xBull, Albedo) and Wagmi/Viem for EVM accounts.
2. **Interactive Route Planner**: Prices all four rails live locally based on deployed router parameters and quotes.
3. **Switchyard visualization**: Live SVG interchange that draws the winning route copper to blue and annotates losing rails.
4. **Transfer flow and stage lamps**: Unnumbered, named stages tracking the cross-chain journey from origin burn/dispatch to destination execution.
5. **Parked claim settlement UI**: Surfaces uninitialized destination claims for permissionless recovery.
6. **Transfer registry and inspector**: Searchable history at `/transfers` and single-transfer inspector at `/transfers/[txHash]`.
7. **Automated verification pipeline**: 24 tests across arithmetic, geometry, API client, and accessibility audits.
8. **CI/CD and governance**: GitHub Actions CI workflow, PR template, CODEOWNERS, SECURITY.md, and dependabot.

### Live deployment

The frontend application is deployed and live on Vercel:

- Web application: https://hyperion-seven-green.vercel.app
- Backend REST API: https://hyperion-backend.vercel.app
- Connected router on Stellar testnet: `CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF`

### Organization links

This web client surfaces on-chain contracts and off-chain indexing services across the StellarHyperion organization:

- Contracts: [stellarhyperion-contracts](https://github.com/StellarHyperion/stellarhyperion-contracts)
- Backend: [stellarhyperion-backend](https://github.com/StellarHyperion/stellarhyperion-backend)

## License

MIT.
