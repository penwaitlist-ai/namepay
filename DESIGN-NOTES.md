# NamePay — Design Notes

## What it is

One contract, no admin: pay BNB or any ERC-20 to a `.ai` Agent ID handle
instead of a raw address. The handle is resolved to its owner's address
through the SPACE ID Agent ID registry
(`0x60b9262456de011f7d15a54cdd8c48baaa8b022f` on BNB Chain) and the funds
are forwarded to that owner in the same transaction. Every payment
leaves a public receipt bound to the sender's and recipient's handles,
and anyone can create a shareable payment request (`?req=<id>`) that
someone else settles exactly once.

## Trust properties

- **No custody, ever.** BNB received by `payBNB`/`payRequest` is
  forwarded with a plain call in the same transaction; tokens move
  directly sender → recipient via `transferFrom`. The contract has no
  `receive()`/`fallback()`, so even a mistaken plain transfer to it
  reverts instead of getting stuck. A token-denominated `payRequest`
  reverts if BNB is attached, for the same reason. If any forward
  fails, the whole transaction reverts — funds can never be parked in
  NamePay.
- **No owner, no admin, no pause, no upgrade, no withdraw.** There is
  nothing to compromise and nobody with privileges — including the
  deployer. Deployment goes through a CREATE2 factory; the constructor
  takes the registry address as an explicit parameter and never reads
  `msg.sender`, so the factory/deployer gains nothing.
- **Holder gate = the metric.** Every state-changing function requires
  `registry.balanceOf(msg.sender) > 0`. Consequence: every address in
  the unique-interactor set is provably an Agent ID holder address,
  which is exactly what the hackathon counts.
- **Reentrancy defence in depth.** Payment functions record all state
  (receipt, `paid` flag, interactor set) *before* any external call
  (checks-effects-interactions) *and* run under a simple mutex. A test
  with a malicious receiver contract proves re-entry fails while the
  outer payment still lands.
- **Registry is read-only for us.** NamePay never approves, moves or
  touches anyone's Agent ID; it only calls `balanceOf`, `handleOf`,
  `ownerOfHandle`.

## Design decisions

- **Registry address as constructor argument (immutable).** The spec's
  mainnet address is passed at deployment; tests inject a mock. This
  also keeps one source deployable to testnets unchanged.
- **Custom errors** (`NotAgentIdHolder`, `UnknownHandle`, …) instead of
  revert strings: cheaper and unambiguous for the website to decode.
- **`transferFrom` via low-level call.** Accepts tokens that return
  `true`, tokens that return nothing (old-style), and reverts on an
  explicit `false` or a reverting token. Verified by tests against a
  standard mock and a false-returning mock.
- **Exact-amount settlement for requests.** A BNB request must be paid
  with `msg.value == amount` — no partial payments, no overpayment
  refunds to design (a refund path would be a custody/edge-case risk).
- **Zero-amount payments are allowed.** The spec sets no minimum, and
  the distribution plan wants the lightest possible first interaction
  (a dust payment still records a receipt and counts the interactor).
  A zero request is likewise creatable; it settles with a zero transfer.
- **String caps:** handles ≤ 64 bytes, memos/notes ≤ 140 bytes,
  enforced on every user-supplied string (registry-returned handles are
  the registry's own data and are not re-capped).
- **`receiptsOf(handle)`** returns receipts where the handle is sender
  *or* recipient — the useful "activity of this name" feed for a
  profile page.

## Known limitations / spec ambiguities

- **`requestId == 0` ambiguity (inherited from the spec).** Receipts
  use `requestId = 0` for "no request", while request ids also start
  at 0, so a receipt settling request #0 is indistinguishable from a
  direct payment by that field alone. Disambiguation is always
  possible: a `RequestPaid(0, payer)` event exists iff request #0 was
  settled, and `requestAt(0)` shows its `paid`/`payer`. Chosen over
  renumbering requests to start at 1, because the spec fixes both
  conventions explicitly (ids are array indices; 0 means none).
- **Linear scans.** `receiptsOf` / `requestsOf` scan the full arrays
  (O(n)). They are view functions intended for off-chain reads
  (website/eth_call), where this is fine at hackathon scale; calling
  them on-chain from another contract would get expensive as the log
  grows. No per-handle index is kept, per the spec's allowance.
- **`stats().totalPayments` counts receipts**, i.e. settled payments
  only — created-but-unpaid requests are not payments.
- **Handle changes:** receipts store the handle strings as they were at
  payment time (a historical record). If the registry ever reassigns a
  handle, old receipts keep the old strings — by design.
- **Token quirks:** fee-on-transfer tokens would deliver less than
  `amount` to the recipient while the receipt records `amount`
  (standard ERC-20 caveat; NamePay cannot detect it without balance
  deltas). Non-standard tokens that revert on zero transfers would make
  zero-amount token payments fail.
- **Runtime size 9,784 bytes** — larger than the plan's early 4–6 KB
  estimate (receipt/request storage + string handling), still far
  under the 24,576-byte limit, with no functional impact.
