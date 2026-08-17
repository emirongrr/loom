# Interaction budget

What each wallet goal costs a person, before and after the recovery-discovery
and send changes.

## How these numbers were produced

**Counted from source, not observed in a browser.** Every figure is derived by
reading the controls a flow renders at two commits: `origin/main` for "before"
and this branch for "after". Each row cites the file that decides it, so a
reviewer can recount rather than trust the table.

This method is exact for controls and inputs, because those are static in the
JSX. It cannot see hesitation, scrolling, error recovery, or how long a step
feels. Reaching most of these screens needs a platform authenticator, which the
development environment used here does not provide, so nothing below is a
usability measurement and none of it should be quoted as one.

Definitions:

- **Clicks** — deliberate control activations on the happy path, excluding
  typing. Opening a screen counts; a control that only reveals existing detail
  counts.
- **Text** — fields a person must fill or paste into.
- **Passkey** — authenticator ceremonies.
- **Chain ops** — user operations or transactions the flow submits.

## Changed by this work

| Goal | Clicks | Text | Passkey | Chain ops | Decided by |
|---|---|---|---|---|---|
| Show someone my address — **before** | 1 | 0 | 0 | 0 | `HomePage.tsx` quick action |
| Show someone my address — **after** | 1 to a QR, 2 to also copy | 0 | 0 | 0 | `ReceiveDialog.tsx` |
| Send ETH from an existing account — **before** | 2 | 2 | 1 | 1 | `SendDialog.tsx` |
| Send ETH from an existing account — **after** | 2 | 2 | 1 | 1 | `SendDialog.tsx`; same count, now with an inline review |
| **First** send from a new account — **before** | 3 | 2 | **2** | **2** | activation card, then `SendDialog.tsx` |
| **First** send from a new account — **after** | 2 | 2 | **1** | **1** | `SendDialog.tsx` activation passthrough |
| Approve a recovery as a guardian — **before** | 3 | **1** | 1 | 0 | paste box in `GuardianWorkspace.tsx` |
| Approve a recovery as a guardian — **after** | 4 | **0** | 1 | 0 | discovery section + `RecoveryApprovalDialog.tsx` |
| Publish that approval on chain — **before** | not possible | — | — | — | no such path existed |
| Publish that approval on chain — **after** | 2 more | 0 | 1 more | 1 | `RecoveryApprovalDialog.tsx` |

### What the numbers do and do not show

**Receive did not get shorter; it started working.** Before and after are both
one interaction. Before, that interaction copied the address to the clipboard
and nothing else: there was no code to scan, no network named, and no way to
tell which chain the address was being offered on. The click count is a bad
summary of that change, which is why it is written out rather than left to the
table.

**First send is the only strict reduction**, and it is in the units that
matter: one fewer authenticator ceremony and one fewer on-chain operation, not
just one fewer click. It is also the only row here where the "before" number
understates the cost, because the two operations are sequential — the second
cannot start until the first confirms.

**Guardian approval costs one more click and removes a dependency.** Before, the
guardian could not act at all until someone reached them and they pasted a
payload; the flow's real precondition was an out-of-band delivery that the
table cannot show. After, the guardian finds the request themselves and types
nothing. Trading a text entry and an external dependency for one click is the
intended trade, not an accident.

**The pre-submit review costs nothing.** Asset, amount, recipient, network, gas
payer, and the fee ceiling are shown inline above the submit button and update
as the draft changes, so the send stays two clicks. A separate confirmation step
would have added a click without adding information, which is the opposite of
what a review is for.

**Scanning a recipient replaces typing, and refuses what it cannot honour.** A
code for another network, or one asking for a token transfer this screen cannot
set up, is rejected with a reason rather than reduced to whatever address it
contains. The camera starts only on an explicit press, stops on every exit path,
and decodes in the page — no frame is uploaded and no decoding service is
contacted.

**Publishing on chain is deliberately not the cheapest path.** It costs two more
clicks than sharing privately because the second is a warning the guardian must
read past: publication is permanent, and an abandoned recovery leaves them
exposed against a guardian set still in use (ADR-0024). This is a case where a
lower number would be a worse product.

## Unchanged by this work

Counted at the same commit for completeness. These flows were not touched, and
no attempt was made to reduce them here.

| Goal | Clicks | Text | Passkey | Chain ops | Notes |
|---|---|---|---|---|---|
| Send an ERC-20 | 3 from the quick action, 2 from its token row | 2 | 1 | 1 | the extra click is choosing the asset, and the token row already preselects it |
| Accept a guardian invitation | 1 | 1 | 0 | 0 | paste the link, review |
| Configure guardians | varies | 1 per guardian | 1 | 1 | plus the account's own three-day config delay |
| Start a recovery | 4 | 2 | 1 by the recovering person | 1 | one ceremony creates the passkey; publishing the validator needs a gas payer, which may be another wallet's ceremony, an external wallet, or a copied transaction |
| Import one guardian response | 1 | 1 | 0 | 0 | repeated per guardian |
| Propose the recovery | 1 | 0 | 0 | 1 | permissionless; submitted through an injected browser wallet, which adds its own confirmation |
| Execute after the delay | 1 | 0 | 0 | 1 | readiness is re-read automatically on open; the manual re-check is optional |

The recovery flow is by far the most expensive thing in the wallet, and this
work did not make it cheaper for the person recovering — it made it possible for
their guardians to participate without being contacted. Reducing the recovering
user's own path is untouched work.

## Security confirmations that must not be optimised away

These are counted above as clicks and are deliberately kept:

- the passkey ceremony on every send;
- the guardian's explicit choice between sharing privately and publishing;
- the on-chain publication warning, which is a second click on purpose;
- the six-digit code a guardian compares out of band before approving;
- explicit account creation on the home screen, kept as a secondary action for
  anyone who would rather not fold it into a send.

A future change that lowers a number in this table should say which of these it
touched, or state that it touched none.

## What is still avoidable friction

Named so the next change has a target, and so the table is not read as a
finished result:

- Sending an ERC-20 from the quick action costs a click to choose the asset.
  That is not avoidable friction: every token row and collectible already has a
  Send button that preselects, so the extra click only appears when the person
  has not yet said what they want to send. Preselecting a guess — the largest
  balance, the most recent — would risk sending the wrong asset, which is worse
  than a click.
- Importing guardian responses is one paste each. Responses published on chain
  are now discoverable, but privately shared ones still arrive by hand.
- Publishing the replacement validator needs someone to pay gas, and the
  guardians cannot approve until it exists — they verify its deployed bytecode
  before signing. Paying with another saved Loom wallet costs that wallet's own
  ceremony; an external wallet or a copied transaction costs none. The ordering
  is a guardian check, not a UI step, so it cannot be collapsed without dropping
  that check.
- Scanning a recipient needs a browser with `BarcodeDetector`; where it is
  absent the button is not shown and the address is typed or pasted. Reaching
  the remaining browsers would mean adding a decoding library to a wallet's
  signing path, which is a supply-chain cost this has not paid.
