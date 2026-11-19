# NamePay — web frontend

A single static page for the NamePay contract (pay BNB or USDT to an Agent ID
`.ai` name on BNB Smart Chain). No build step and no external network
dependencies at runtime: `ethers` ships locally as `ethers.umd.min.js`, and
all chain access goes through the visitor's injected wallet
(`window.ethereum`).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure and copy. |
| `style.css` | All styling (system fonts only). |
| `app.js` | Wallet connection, identity check, payments, requests, stats, feed. |
| `demo.html` / `demo.js` | 30-second demo: prefilled dust payment (0.0001 BNB to `ririn12`) plus a public receipt wall read over a public RPC — loads with no wallet connected. |
| `SKILL.md` | Integration skill for AI agents: how an agent holding an Agent ID pays by name through NamePay (also served at https://penwaitlist-ai.github.io/namepay/SKILL.md). |
| `ethers.umd.min.js` | ethers v6.17.0 browser bundle, vendored locally. |

## For AI agents

If you are an AI agent whose wallet holds an Agent ID, read
[`SKILL.md`](SKILL.md): it documents the exact contract calls, the
bare-handle rule, the payment-request flow, and the safety rules for paying
through NamePay programmatically.

## Serve it

Any static file server works, e.g. from this directory:

```sh
python3 -m http.server 8080
# then open http://localhost:8080 in a Web3 wallet browser
```

To actually pay, open the page inside the Binance Wallet app browser (or any
wallet browser with an injected provider) on BNB Smart Chain (chainId 56)
with a wallet that holds an Agent ID.

## Configuration — read this before going live

All deployment constants live in the `CONFIG` object at the **top of
`app.js`**. If the deployed NamePay address differs from the
CREATE2-predicted one, change exactly one value:

```js
NAMEPAY_ADDRESS: "0x585723d33a9e26f8289db92b9ca898d7211457bd",
```

The other constants should not need changes: the Agent ID registry
(`0x60b9262456de011f7d15a54cdd8c48baaa8b022f`), BSC USDT
(`0x55d398326f99059fF775485246999027B3197955`), and chainId 56 are fixed
facts of the deployment target. The page detects a wrong/missing contract at
the configured address (`eth_getCode`) and shows a "not live yet" notice
instead of letting payments fail obscurely.

USDT decimals are read from the token contract at runtime (18 on BSC), with
an 18 fallback.

## Handle-format decision

**Canonical form: the BARE handle with no suffix — e.g. `ririn12`.**

Why: live registry calls on 2026-11-18 settled this definitively (the
contract source's NatSpec example, which showed `"ririn12.ai"`, is wrong).
`handleOf(0x0DBc…Fb7b)` returns `"ririn12"`; `ownerOfHandle("ririn12")`
returns the owner address, while `ownerOfHandle("ririn12.ai")` returns the
zero address. NamePay passes handle strings straight through to the
registry and matches receipts/requests by exact string hash, so every
contract call in this app uses the bare form.

UI behaviour derived from that:

- Input fields accept `name` or `name.ai` (plus stray whitespace / a
  trailing dot) and normalize to the lowercase BARE handle before any
  call — a typed `.ai` suffix is stripped.
- Handles read from the chain are the bare form; the UI appends `.ai`
  for display only (`displayHandle`), never for a contract call.
- "My requests" queries `requestsOf()` with the exact string returned by
  `handleOf(user)`, guaranteeing an exact match with what the contract
  stored at creation time.

## Feature → contract-call map

| UI feature | Calls |
| --- | --- |
| Connect / session restore | `eth_requestAccounts` / `provider.listAccounts()`, `wallet_switchEthereumChain` (+ `wallet_addEthereumChain` on error 4902) |
| Identity panel | registry `balanceOf(user)`, `handleOf(user)`; NamePay `hasInteracted(user)` |
| Recipient hint + pre-send check | registry `ownerOfHandle(handle)` |
| Pay with BNB | NamePay `payBNB(handle, memo)` with `value` |
| Pay with USDT | ERC-20 `allowance(user, NamePay)` → `approve(NamePay, amount)` if needed → NamePay `payToken(USDT, handle, amount, memo)` |
| Create request | NamePay `createRequest(tokenOrZero, amount, note)`; new id parsed from the `RequestCreated` event in the tx receipt (fallback: `requestCount() - 1`) |
| My requests | NamePay `requestsOf(myHandle)` + `requestAt(id)` |
| Shared request page (`?req=<id>`) | NamePay `requestAt(id)`; pay via `payRequest(id)` with exact BNB `value`, or the USDT approve flow then `payRequest(id)` |
| Stats header + milestone bar | NamePay `stats()` → `totalPayments`, `uniqueInteractors` (milestone: 30) |
| Recent payments feed | NamePay `receiptCount()` + `receiptAt(i)` for the last 20 |

## Safety / copy notes

- The page never asks for a signature other than wallet transactions the
  user initiates, and never touches keys or seed phrases.
- Copy states plainly that on-chain payments are final and cannot be
  reversed, and that NamePay never holds funds (sender → name owner in one
  transaction; the contract has no owner/admin/withdraw). No returns,
  earnings, or profit claims appear anywhere.
