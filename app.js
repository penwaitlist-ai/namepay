/* ============================================================================
   NamePay — frontend logic
   ----------------------------------------------------------------------------
   CONFIG: if the deployed NamePay address differs from the CREATE2-predicted
   one, change NAMEPAY_ADDRESS below — it is the only address the page talks
   to besides the Agent ID registry and USDT. Everything else is derived.

   HANDLE FORMAT (see README.md): LIVE-VERIFIED against the registry on
   2026-11-18 — handleOf() returns the BARE handle WITHOUT any suffix
   (e.g. "ririn12"), and ownerOfHandle() takes that same bare string;
   ownerOfHandle("ririn12.ai") returns the zero address. The canonical form
   everywhere in this app is therefore the bare handle. The UI accepts
   "name" or "name.ai" as input and normalizes to the bare "name"; ".ai"
   is presentation only (displayHandle) and is never sent to a contract.
   ========================================================================== */

const CONFIG = {
  NAMEPAY_ADDRESS: "0x585723d33a9e26f8289db92b9ca898d7211457bd",
  REGISTRY_ADDRESS: "0x60b9262456de011f7d15a54cdd8c48baaa8b022f",
  USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
  CHAIN_ID: 56,
  CHAIN_ID_HEX: "0x38",
  BSCSCAN_BASE: "https://bscscan.com",
  MILESTONE_INTERACTORS: 30, // hackathon eligibility milestone
  FEED_LIMIT: 20,
  MAX_HANDLE_BYTES: 64, // mirrors NamePay.MAX_HANDLE_BYTES
  MAX_TEXT_BYTES: 140,   // mirrors NamePay.MAX_TEXT_BYTES
};

/* ABI fragments copied verbatim from build/NamePay.json (only the functions
   and events this page uses, plus the contract's custom errors so ethers can
   decode reverts into friendly messages). Struct field order:
   Receipt(sender, fromHandle, toHandle, token, amount, memo, requestId, timestamp)
   PaymentRequest(creator, creatorHandle, token, amount, note, paid, payer) */
const NAMEPAY_ABI = [
  { "type": "function", "name": "createRequest", "inputs": [{ "name": "token", "type": "address" }, { "name": "amount", "type": "uint256" }, { "name": "note", "type": "string" }], "outputs": [{ "name": "id", "type": "uint256" }], "stateMutability": "nonpayable" },
  { "type": "function", "name": "hasInteracted", "inputs": [{ "name": "account", "type": "address" }], "outputs": [{ "name": "", "type": "bool" }], "stateMutability": "view" },
  { "type": "function", "name": "payBNB", "inputs": [{ "name": "toHandle", "type": "string" }, { "name": "memo", "type": "string" }], "outputs": [], "stateMutability": "payable" },
  { "type": "function", "name": "payRequest", "inputs": [{ "name": "id", "type": "uint256" }], "outputs": [], "stateMutability": "payable" },
  { "type": "function", "name": "payToken", "inputs": [{ "name": "token", "type": "address" }, { "name": "toHandle", "type": "string" }, { "name": "amount", "type": "uint256" }, { "name": "memo", "type": "string" }], "outputs": [], "stateMutability": "nonpayable" },
  { "type": "function", "name": "receiptAt", "inputs": [{ "name": "i", "type": "uint256" }], "outputs": [{ "name": "", "type": "tuple", "components": [{ "name": "sender", "type": "address" }, { "name": "fromHandle", "type": "string" }, { "name": "toHandle", "type": "string" }, { "name": "token", "type": "address" }, { "name": "amount", "type": "uint256" }, { "name": "memo", "type": "string" }, { "name": "requestId", "type": "uint256" }, { "name": "timestamp", "type": "uint256" }] }], "stateMutability": "view" },
  { "type": "function", "name": "receiptCount", "inputs": [], "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view" },
  { "type": "function", "name": "requestAt", "inputs": [{ "name": "id", "type": "uint256" }], "outputs": [{ "name": "", "type": "tuple", "components": [{ "name": "creator", "type": "address" }, { "name": "creatorHandle", "type": "string" }, { "name": "token", "type": "address" }, { "name": "amount", "type": "uint256" }, { "name": "note", "type": "string" }, { "name": "paid", "type": "bool" }, { "name": "payer", "type": "address" }] }], "stateMutability": "view" },
  { "type": "function", "name": "requestCount", "inputs": [], "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view" },
  { "type": "function", "name": "requestsOf", "inputs": [{ "name": "handle", "type": "string" }], "outputs": [{ "name": "ids", "type": "uint256[]" }], "stateMutability": "view" },
  { "type": "function", "name": "stats", "inputs": [], "outputs": [{ "name": "totalPayments", "type": "uint256" }, { "name": "uniqueInteractors", "type": "uint256" }], "stateMutability": "view" },
  { "type": "event", "name": "Payment", "inputs": [{ "name": "sender", "type": "address", "indexed": true }, { "name": "fromHandle", "type": "string", "indexed": false }, { "name": "toHandle", "type": "string", "indexed": false }, { "name": "token", "type": "address", "indexed": false }, { "name": "amount", "type": "uint256", "indexed": false }, { "name": "memo", "type": "string", "indexed": false }, { "name": "requestId", "type": "uint256", "indexed": false }], "anonymous": false },
  { "type": "event", "name": "RequestCreated", "inputs": [{ "name": "id", "type": "uint256", "indexed": false }, { "name": "creatorHandle", "type": "string", "indexed": false }, { "name": "token", "type": "address", "indexed": false }, { "name": "amount", "type": "uint256", "indexed": false }, { "name": "note", "type": "string", "indexed": false }], "anonymous": false },
  { "type": "event", "name": "RequestPaid", "inputs": [{ "name": "id", "type": "uint256", "indexed": false }, { "name": "payer", "type": "address", "indexed": false }], "anonymous": false },
  { "type": "error", "name": "ForwardFailed", "inputs": [] },
  { "type": "error", "name": "NotAgentIdHolder", "inputs": [] },
  { "type": "error", "name": "ReentrantCall", "inputs": [] },
  { "type": "error", "name": "RequestAlreadyPaid", "inputs": [{ "name": "id", "type": "uint256" }] },
  { "type": "error", "name": "RequestNotFound", "inputs": [{ "name": "id", "type": "uint256" }] },
  { "type": "error", "name": "StringTooLong", "inputs": [{ "name": "length", "type": "uint256" }, { "name": "max", "type": "uint256" }] },
  { "type": "error", "name": "TokenTransferFailed", "inputs": [] },
  { "type": "error", "name": "UnknownHandle", "inputs": [{ "name": "handle", "type": "string" }] },
  { "type": "error", "name": "ValueMismatch", "inputs": [{ "name": "expected", "type": "uint256" }, { "name": "actual", "type": "uint256" }] },
  { "type": "error", "name": "ZeroRegistry", "inputs": [] },
  { "type": "error", "name": "ZeroToken", "inputs": [] },
];

/* Minimal Agent ID registry surface (from the task spec / NamePay.sol). */
const REGISTRY_ABI = [
  { "type": "function", "name": "balanceOf", "inputs": [{ "name": "account", "type": "address" }], "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view" },
  { "type": "function", "name": "handleOf", "inputs": [{ "name": "account", "type": "address" }], "outputs": [{ "name": "", "type": "string" }], "stateMutability": "view" },
  { "type": "function", "name": "ownerOfHandle", "inputs": [{ "name": "handle", "type": "string" }], "outputs": [{ "name": "", "type": "address" }], "stateMutability": "view" },
];

/* Minimal ERC-20 surface for the USDT approve + pay flow. */
const ERC20_ABI = [
  { "type": "function", "name": "allowance", "inputs": [{ "name": "owner", "type": "address" }, { "name": "spender", "type": "address" }], "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view" },
  { "type": "function", "name": "approve", "inputs": [{ "name": "spender", "type": "address" }, { "name": "amount", "type": "uint256" }], "outputs": [{ "name": "", "type": "bool" }], "stateMutability": "nonpayable" },
  { "type": "function", "name": "decimals", "inputs": [], "outputs": [{ "name": "", "type": "uint8" }], "stateMutability": "view" },
];

/* ------------------------------ state ------------------------------ */

const state = {
  provider: null,       // ethers BrowserProvider over window.ethereum
  signer: null,
  user: null,           // connected address or null
  chainOk: false,
  contractLive: false,
  isHolder: false,
  myHandle: null,       // exact handleOf() string, bare form, e.g. "ririn12"
  namepayRead: null,    // provider-bound (view calls)
  namepay: null,        // signer-bound (transactions)
  registryRead: null,
  usdtRead: null,
  usdt: null,           // signer-bound USDT
  usdtDecimals: 18,
  reqPanelId: null,     // BigInt id from ?req=, or null
  reqPanelRequest: null,
  busy: false,
};

/* ------------------------------ helpers ------------------------------ */

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortAddr(a) {
  if (!a) return "—";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function byteLen(s) {
  return new TextEncoder().encode(s).length;
}

/* Normalize user input to the canonical registry form: the BARE handle.
   Accepts "name", "name.ai", stray whitespace and a trailing dot; a typed
   ".ai" suffix is stripped because the registry does not use it. Agent ID
   handles are lowercase, so input is lowercased. Returns null if empty. */
function normalizeHandle(raw) {
  if (!raw) return null;
  let h = String(raw).trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.endsWith(".ai")) h = h.slice(0, -3);
  if (!h) return null;
  return h;
}

/* Presentation only: humans read "ririn12.ai"; contracts never see this. */
function displayHandle(h) {
  if (!h) return "—";
  return h.endsWith(".ai") ? h : h + ".ai";
}

function trimAmount(formatted) {
  if (!formatted.includes(".")) return formatted;
  return formatted.replace(/0+$/, "").replace(/\.$/, ".0");
}

function assetInfo(token) {
  if (!token || token === ethers.ZeroAddress) return { symbol: "BNB", decimals: 18 };
  if (token.toLowerCase() === CONFIG.USDT_ADDRESS.toLowerCase()) {
    return { symbol: "USDT", decimals: state.usdtDecimals };
  }
  return { symbol: "token " + shortAddr(token), decimals: 18 };
}

function fmtAmount(amount, token) {
  const info = assetInfo(token);
  return trimAmount(ethers.formatUnits(amount, info.decimals)) + " " + info.symbol;
}

function txLink(hash) {
  const url = CONFIG.BSCSCAN_BASE + "/tx/" + hash;
  return `<a href="${url}" target="_blank" rel="noopener">View on BscScan</a>`;
}

function setStatus(el, html, kind) {
  el.innerHTML = html;
  el.className = "status" + (kind ? " " + kind : "");
}

function friendlyError(e) {
  if (!e) return "Something went wrong.";
  if (e.code === "ACTION_REJECTED" || e.code === 4001) {
    return "Transaction rejected in your wallet.";
  }
  const name =
    (e.revert && e.revert.name) ||
    (e.info && e.info.error && e.info.error.name) ||
    null;
  switch (name) {
    case "NotAgentIdHolder":
      return "Your wallet does not hold an Agent ID, so it cannot use NamePay.";
    case "UnknownHandle":
      return "That .ai name is not registered to anyone.";
    case "RequestNotFound":
      return "That payment request does not exist.";
    case "RequestAlreadyPaid":
      return "That payment request has already been paid.";
    case "ValueMismatch":
      return "The amount sent did not match the requested amount.";
    case "StringTooLong":
      return "A text field is too long (names max 64 bytes, memos/notes max 140 bytes).";
    case "TokenTransferFailed":
      return "The token transfer failed. Check your balance and allowance, then try again.";
    case "ForwardFailed":
      return "Forwarding the payment to the recipient failed, so nothing was sent.";
    default:
      break;
  }
  const msg = (e.shortMessage || e.reason || e.message || "").toString();
  if (/insufficient funds/i.test(msg)) return "Insufficient funds for this payment and its network fee.";
  if (/user rejected|denied/i.test(msg)) return "Transaction rejected in your wallet.";
  return msg ? escapeHtml(msg) : "Something went wrong.";
}

function shareLink(id) {
  const base = window.location.origin && window.location.origin !== "null"
    ? window.location.origin + window.location.pathname
    : window.location.href.split("?")[0];
  return base + "?req=" + id.toString();
}

/* ------------------------------ gating ------------------------------ */

function refreshActionStates() {
  const canAct = !!state.user && state.chainOk && state.contractLive && state.isHolder && !state.busy;
  $("payFieldset").disabled = !canAct;
  $("createFieldset").disabled = !canAct;
  const req = state.reqPanelRequest;
  $("reqPayBtn").disabled = !(canAct && req && !req.paid);
}

/* ------------------------------ wallet ------------------------------ */

async function ensureChain() {
  const net = await state.provider.getNetwork();
  state.chainOk = net.chainId === BigInt(CONFIG.CHAIN_ID);
  $("chainBanner").classList.toggle("hidden", state.chainOk || !state.user);
  return state.chainOk;
}

async function switchChain() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CONFIG.CHAIN_ID_HEX }],
    });
  } catch (e) {
    if (e && e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: CONFIG.CHAIN_ID_HEX,
          chainName: "BNB Smart Chain",
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: ["https://bsc-dataseed.binance.org/"],
          blockExplorerUrls: [CONFIG.BSCSCAN_BASE],
        }],
      });
    } else {
      throw e;
    }
  }
}

async function setupSigner(address) {
  state.user = address;
  state.signer = await state.provider.getSigner();
  state.namepay = new ethers.Contract(CONFIG.NAMEPAY_ADDRESS, NAMEPAY_ABI, state.signer);
  state.usdt = new ethers.Contract(CONFIG.USDT_ADDRESS, ERC20_ABI, state.signer);
  $("accountChip").textContent = shortAddr(address);
  $("accountChip").classList.remove("hidden");
  $("connectBtn").textContent = "Connected";
  $("connectBtn").disabled = true;
  await ensureChain();
  await loadIdentity();
  await loadMyRequests();
  refreshActionStates();
}

async function connect() {
  if (!window.ethereum) return;
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (accounts && accounts.length > 0) await setupSigner(accounts[0]);
  } catch (e) {
    setStatus($("payStatus"), escapeHtml(friendlyError(e)), "err");
  }
}

async function loadIdentity() {
  const reg = state.registryRead;
  $("identityDisconnected").classList.add("hidden");
  try {
    const bal = await reg.balanceOf(state.user);
    if (bal === 0n) {
      state.isHolder = false;
      state.myHandle = null;
      $("identityHolder").classList.add("hidden");
      $("identityNoId").classList.remove("hidden");
      $("myAddressNoId").textContent = state.user;
      $("myRequests").innerHTML = '<p class="muted">An Agent ID is required to create requests.</p>';
      return;
    }
    state.isHolder = true;
    state.myHandle = await reg.handleOf(state.user);
    $("identityNoId").classList.add("hidden");
    $("identityHolder").classList.remove("hidden");
    $("myHandle").textContent = displayHandle(state.myHandle);
    $("myAddress").textContent = state.user;
    const interacted = await state.namepayRead.hasInteracted(state.user);
    $("interactedNote").textContent = interacted
      ? "You have already paid or created a request with NamePay — you are counted in the holders total above."
      : "You have not interacted with NamePay yet. Your first payment or request adds you to the holders total above.";
  } catch (e) {
    state.isHolder = false;
    $("identityHolder").classList.add("hidden");
    $("identityNoId").classList.remove("hidden");
    $("myAddressNoId").textContent = state.user;
  }
}

/* ------------------------------ reads ------------------------------ */

async function loadStats() {
  try {
    const s = await state.namepayRead.stats();
    const total = Number(s.totalPayments);
    const unique = Number(s.uniqueInteractors);
    $("statPayments").textContent = total.toLocaleString();
    $("statInteractors").textContent = unique.toLocaleString();
    const pct = Math.min(100, (unique / CONFIG.MILESTONE_INTERACTORS) * 100);
    $("progressFill").style.width = pct + "%";
    $("progressTrack").setAttribute("aria-valuenow", String(Math.min(unique, CONFIG.MILESTONE_INTERACTORS)));
    $("progressLabel").textContent = unique >= CONFIG.MILESTONE_INTERACTORS
      ? `Milestone reached: ${unique} Agent ID holders have interacted (goal was ${CONFIG.MILESTONE_INTERACTORS}).`
      : `${unique} of ${CONFIG.MILESTONE_INTERACTORS} Agent ID holders — the hackathon eligibility milestone.`;
  } catch (e) {
    $("progressLabel").textContent = "Activity unavailable right now.";
  }
}

async function loadFeed() {
  const feed = $("feed");
  try {
    const count = Number(await state.namepayRead.receiptCount());
    if (count === 0) {
      feed.innerHTML = '<p class="muted">No payments yet. Be the first to pay a name.</p>';
      return;
    }
    const start = Math.max(0, count - CONFIG.FEED_LIMIT);
    const idx = [];
    for (let i = count - 1; i >= start; i--) idx.push(i);
    const receipts = await Promise.all(idx.map((i) => state.namepayRead.receiptAt(i)));
    feed.innerHTML = receipts.map((r) => {
      const when = new Date(Number(r.timestamp) * 1000).toLocaleString();
      const memo = r.memo ? `<div class="feed-memo">“${escapeHtml(r.memo)}”</div>` : "";
      return `<div class="feed-item">
        <div class="feed-top">
          <span><strong>${escapeHtml(displayHandle(r.fromHandle))}</strong> → <strong>${escapeHtml(displayHandle(r.toHandle))}</strong></span>
          <span class="feed-amount">${escapeHtml(fmtAmount(r.amount, r.token))}</span>
        </div>
        ${memo}
        <div class="feed-time">${escapeHtml(when)}</div>
      </div>`;
    }).join("");
  } catch (e) {
    feed.innerHTML = '<p class="muted">Could not load recent payments.</p>';
  }
}

async function loadMyRequests() {
  const box = $("myRequests");
  if (!state.user || !state.isHolder || !state.myHandle) return;
  try {
    const ids = await state.namepayRead.requestsOf(state.myHandle);
    if (ids.length === 0) {
      box.innerHTML = '<p class="muted">You have not created any requests yet.</p>';
      return;
    }
    const newestFirst = [...ids].reverse().slice(0, 20);
    const reqs = await Promise.all(newestFirst.map((id) => state.namepayRead.requestAt(id)));
    box.innerHTML = newestFirst.map((id, k) => {
      const r = reqs[k];
      const status = r.paid
        ? `<span class="badge paid">Paid by ${escapeHtml(shortAddr(r.payer))}</span>`
        : '<span class="badge open">Open</span>';
      const note = r.note ? `<div class="muted">“${escapeHtml(r.note)}”</div>` : "";
      const link = shareLink(id);
      return `<div class="req-item">
        <div class="req-top">
          <span class="req-amount">${escapeHtml(fmtAmount(r.amount, r.token))}</span>
          ${status}
        </div>
        ${note}
        <div class="share-row">
          <input type="text" readonly value="${escapeHtml(link)}" aria-label="Share link for request ${id.toString()}">
          <button class="btn btn-small" type="button" data-copy="${escapeHtml(link)}">Copy</button>
        </div>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(btn.getAttribute("data-copy")); btn.textContent = "Copied"; }
        catch { btn.textContent = "Copy failed"; }
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      });
    });
  } catch (e) {
    box.innerHTML = '<p class="muted">Could not load your requests.</p>';
  }
}

/* ------------------------------ ?req= panel ------------------------------ */

async function loadReqPanel() {
  if (state.reqPanelId === null) return;
  const id = state.reqPanelId;
  $("reqPanel").classList.remove("hidden");
  $("reqPanelId").textContent = "#" + id.toString();
  try {
    const r = await state.namepayRead.requestAt(id);
    state.reqPanelRequest = r;
    const status = r.paid
      ? `<span class="badge paid">Paid by ${escapeHtml(shortAddr(r.payer))}</span>`
      : '<span class="badge open">Open</span>';
    const note = r.note ? `<p>“${escapeHtml(r.note)}”</p>` : "";
    $("reqPanelBody").innerHTML = `
      <p><strong>${escapeHtml(displayHandle(r.creatorHandle))}</strong> requested
      <strong>${escapeHtml(fmtAmount(r.amount, r.token))}</strong>. ${status}</p>
      ${note}
      <p class="muted small">Paying settles this request in one transaction, directly to the requester's wallet.</p>`;
    $("reqPanelActions").classList.toggle("hidden", !!r.paid);
  } catch (e) {
    state.reqPanelRequest = null;
    $("reqPanelBody").innerHTML = '<p class="muted">This payment request could not be found. It may not exist yet.</p>';
    $("reqPanelActions").classList.add("hidden");
  }
  refreshActionStates();
}

/* ------------------------------ token helper ------------------------------ */

/* Ensures NamePay may pull `amount` of USDT from the user; runs approve
   first when the current allowance is too small. Status goes to `statusEl`. */
async function ensureUsdtAllowance(amount, statusEl) {
  const allowance = await state.usdt.allowance(state.user, CONFIG.NAMEPAY_ADDRESS);
  if (allowance >= amount) return;
  setStatus(statusEl, "Step 1 of 2: approve NamePay to move your USDT for this payment. Confirm in your wallet…", "info");
  const tx = await state.usdt.approve(CONFIG.NAMEPAY_ADDRESS, amount);
  setStatus(statusEl, `Approval sent. ${txLink(tx.hash)} Waiting for confirmation…`, "info");
  await tx.wait();
  setStatus(statusEl, "Approval confirmed. Step 2 of 2: sending the payment…", "info");
}

/* ------------------------------ actions ------------------------------ */

function parseAmountInput(raw, decimals, statusEl) {
  const v = String(raw || "").trim();
  if (!/^\d+(\.\d+)?$/.test(v)) {
    setStatus(statusEl, "Enter a valid amount, e.g. 0.01.", "err");
    return null;
  }
  try {
    const parsed = ethers.parseUnits(v, decimals);
    if (parsed <= 0n) {
      setStatus(statusEl, "Amount must be more than zero.", "err");
      return null;
    }
    return parsed;
  } catch {
    setStatus(statusEl, "That amount has too many decimal places.", "err");
    return null;
  }
}

let resolveTimer = null;
async function hintResolve() {
  const note = $("resolveNote");
  const handle = normalizeHandle($("payHandle").value);
  if (!handle) { note.textContent = ""; return; }
  try {
    const owner = await state.registryRead.ownerOfHandle(handle);
    note.textContent = owner === ethers.ZeroAddress
      ? `${handle} is not registered to anyone.`
      : `Pays ${handle} → ${shortAddr(owner)}`;
  } catch {
    note.textContent = "";
  }
}

async function onPay() {
  const statusEl = $("payStatus");
  const handle = normalizeHandle($("payHandle").value);
  if (!handle) { setStatus(statusEl, "Enter the recipient's .ai name.", "err"); return; }
  if (byteLen(handle) > CONFIG.MAX_HANDLE_BYTES) { setStatus(statusEl, "That name is too long.", "err"); return; }
  const memo = $("payMemo").value.trim();
  if (byteLen(memo) > CONFIG.MAX_TEXT_BYTES) { setStatus(statusEl, "Memo is too long (max 140 characters).", "err"); return; }
  const asset = $("payAsset").value;
  const decimals = asset === "BNB" ? 18 : state.usdtDecimals;
  const amount = parseAmountInput($("payAmount").value, decimals, statusEl);
  if (amount === null) return;

  state.busy = true; refreshActionStates();
  try {
    const owner = await state.registryRead.ownerOfHandle(handle);
    if (owner === ethers.ZeroAddress) {
      setStatus(statusEl, `${escapeHtml(handle)} is not registered to anyone. Check the name and try again.`, "err");
      return;
    }
    let tx;
    if (asset === "BNB") {
      setStatus(statusEl, "Confirm the payment in your wallet…", "info");
      tx = await state.namepay.payBNB(handle, memo, { value: amount });
    } else {
      await ensureUsdtAllowance(amount, statusEl);
      setStatus(statusEl, "Confirm the payment in your wallet…", "info");
      tx = await state.namepay.payToken(CONFIG.USDT_ADDRESS, handle, amount, memo);
    }
    setStatus(statusEl, `Payment sent. ${txLink(tx.hash)} Waiting for confirmation…`, "info");
    await tx.wait();
    setStatus(statusEl, `Paid ${escapeHtml(fmtAmount(amount, asset === "BNB" ? ethers.ZeroAddress : CONFIG.USDT_ADDRESS))} to ${escapeHtml(handle)}. ${txLink(tx.hash)}`, "ok");
    $("payAmount").value = "";
    $("payMemo").value = "";
    await Promise.all([loadStats(), loadFeed(), loadIdentity()]);
  } catch (e) {
    setStatus(statusEl, escapeHtml(friendlyError(e)), "err");
  } finally {
    state.busy = false; refreshActionStates();
  }
}

async function onCreate() {
  const statusEl = $("createStatus");
  const asset = $("reqAsset").value;
  const decimals = asset === "BNB" ? 18 : state.usdtDecimals;
  const amount = parseAmountInput($("reqAmount").value, decimals, statusEl);
  if (amount === null) return;
  const note = $("reqNote").value.trim();
  if (byteLen(note) > CONFIG.MAX_TEXT_BYTES) { setStatus(statusEl, "Note is too long (max 140 characters).", "err"); return; }
  const token = asset === "BNB" ? ethers.ZeroAddress : CONFIG.USDT_ADDRESS;

  state.busy = true; refreshActionStates();
  try {
    setStatus(statusEl, "Confirm in your wallet to create the request…", "info");
    const tx = await state.namepay.createRequest(token, amount, note);
    setStatus(statusEl, `Request sent. ${txLink(tx.hash)} Waiting for confirmation…`, "info");
    const receipt = await tx.wait();
    let newId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = state.namepay.interface.parseLog(log);
        if (parsed && parsed.name === "RequestCreated") { newId = parsed.args.id; break; }
      } catch { /* not a NamePay log */ }
    }
    if (newId === null) {
      // Fallback: the new request is the latest one.
      const count = await state.namepayRead.requestCount();
      newId = count - 1n;
    }
    const link = shareLink(newId);
    $("createdLinkInput").value = link;
    $("createdLink").classList.remove("hidden");
    setStatus(statusEl, `Request #${newId.toString()} created. Share the link below so the payer can settle it. ${txLink(tx.hash)}`, "ok");
    $("reqAmount").value = "";
    $("reqNote").value = "";
    await Promise.all([loadMyRequests(), loadIdentity()]);
  } catch (e) {
    setStatus(statusEl, escapeHtml(friendlyError(e)), "err");
  } finally {
    state.busy = false; refreshActionStates();
  }
}

async function onPayRequest() {
  const statusEl = $("reqStatus");
  const id = state.reqPanelId;
  const req = state.reqPanelRequest;
  if (id === null || !req) return;
  if (req.paid) { setStatus(statusEl, "This request has already been paid.", "err"); return; }

  state.busy = true; refreshActionStates();
  try {
    let tx;
    if (req.token === ethers.ZeroAddress) {
      setStatus(statusEl, "Confirm the payment in your wallet…", "info");
      tx = await state.namepay.payRequest(id, { value: req.amount });
    } else {
      await ensureUsdtAllowance(req.amount, statusEl);
      setStatus(statusEl, "Confirm the payment in your wallet…", "info");
      tx = await state.namepay.payRequest(id);
    }
    setStatus(statusEl, `Payment sent. ${txLink(tx.hash)} Waiting for confirmation…`, "info");
    await tx.wait();
    setStatus(statusEl, `Request #${id.toString()} paid: ${escapeHtml(fmtAmount(req.amount, req.token))} to ${escapeHtml(displayHandle(req.creatorHandle))}. ${txLink(tx.hash)}`, "ok");
    await Promise.all([loadStats(), loadFeed(), loadReqPanel(), loadIdentity()]);
  } catch (e) {
    setStatus(statusEl, escapeHtml(friendlyError(e)), "err");
  } finally {
    state.busy = false; refreshActionStates();
  }
}

/* ------------------------------ init ------------------------------ */

async function init() {
  $("contractLink").textContent = CONFIG.NAMEPAY_ADDRESS;
  $("contractLink").href = CONFIG.BSCSCAN_BASE + "/address/" + CONFIG.NAMEPAY_ADDRESS;

  const params = new URLSearchParams(window.location.search);
  const rawReq = params.get("req");
  if (rawReq !== null && /^\d+$/.test(rawReq.trim())) {
    state.reqPanelId = BigInt(rawReq.trim());
  }

  if (!window.ethereum) {
    $("noWallet").classList.remove("hidden");
    $("connectBtn").disabled = true;
    $("payFieldset").disabled = true;
    $("createFieldset").disabled = true;
    $("progressLabel").textContent = "Open this page in a wallet browser to load live activity.";
    $("feed").innerHTML = '<p class="muted">Open this page in a wallet browser to see recent payments.</p>';
    return;
  }

  state.provider = new ethers.BrowserProvider(window.ethereum);
  state.namepayRead = new ethers.Contract(CONFIG.NAMEPAY_ADDRESS, NAMEPAY_ABI, state.provider);
  state.registryRead = new ethers.Contract(CONFIG.REGISTRY_ADDRESS, REGISTRY_ABI, state.provider);
  state.usdtRead = new ethers.Contract(CONFIG.USDT_ADDRESS, ERC20_ABI, state.provider);

  try { state.usdtDecimals = Number(await state.usdtRead.decimals()); } catch { state.usdtDecimals = 18; }

  try {
    const code = await state.provider.getCode(CONFIG.NAMEPAY_ADDRESS);
    state.contractLive = code && code !== "0x";
  } catch { state.contractLive = false; }
  $("contractNotice").classList.toggle("hidden", state.contractLive);

  await Promise.all([loadStats(), loadFeed(), loadReqPanel()]);

  // Restore an already-authorized session without prompting.
  try {
    const accounts = await state.provider.listAccounts();
    if (accounts && accounts.length > 0) await setupSigner(accounts[0].address);
  } catch { /* stay disconnected */ }

  refreshActionStates();

  window.ethereum.on("chainChanged", () => window.location.reload());
  window.ethereum.on("accountsChanged", () => window.location.reload());

  $("connectBtn").addEventListener("click", connect);
  $("switchChainBtn").addEventListener("click", async () => {
    try { await switchChain(); } catch (e) { /* chainChanged reload handles success */ }
  });
  $("payBtn").addEventListener("click", onPay);
  $("createBtn").addEventListener("click", onCreate);
  $("reqPayBtn").addEventListener("click", onPayRequest);
  $("payHandle").addEventListener("input", () => {
    clearTimeout(resolveTimer);
    resolveTimer = setTimeout(hintResolve, 500);
  });
  $("copyCreatedBtn").addEventListener("click", async () => {
    const btn = $("copyCreatedBtn");
    try { await navigator.clipboard.writeText($("createdLinkInput").value); btn.textContent = "Copied"; }
    catch { btn.textContent = "Copy failed"; }
    setTimeout(() => { btn.textContent = "Copy"; }, 1500);
  });
}

document.addEventListener("DOMContentLoaded", init);
