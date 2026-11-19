/* ============================================================================
   NamePay — 30-second demo page logic
   ----------------------------------------------------------------------------
   Two independent halves:
   1) PUBLIC READ PATH — the stats bar and the receipt wall are read through a
      plain JSON-RPC provider, so they load for ANY visitor (no wallet
      browser required). This is the public wall.
   2) DEMO PAYMENT — a prefilled dust payment (0.0001 BNB to the demo name
      "ririn12") through the visitor's own injected wallet. The visitor
      confirms in their wallet as usual; nothing is signed for them.
   Handle format: the registry's canonical form is the BARE handle
   ("ririn12"); ".ai" is presentation only (see app.js header note).
   ========================================================================== */

const CONFIG = {
  NAMEPAY_ADDRESS: "0x585723d33a9e26f8289db92b9ca898d7211457bd",
  REGISTRY_ADDRESS: "0x60b9262456de011f7d15a54cdd8c48baaa8b022f",
  USDT_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
  CHAIN_ID: 56,
  CHAIN_ID_HEX: "0x38",
  BSCSCAN_BASE: "https://bscscan.com",
  MILESTONE_INTERACTORS: 30, // hackathon eligibility milestone
  WALL_LIMIT: 50,
  DEMO_HANDLE: "ririn12",          // bare handle of the demo name
  DEMO_AMOUNT_BNB: "0.0001",
  DEMO_MEMO: "Trying the NamePay demo",
  READ_RPCS: [
    "https://bsc-dataseed.bnbchain.org",
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed1.defibit.io",
  ],
};

const NAMEPAY_ABI = [
  { "type": "function", "name": "hasInteracted", "inputs": [{ "name": "account", "type": "address" }], "outputs": [{ "name": "", "type": "bool" }], "stateMutability": "view" },
  { "type": "function", "name": "payBNB", "inputs": [{ "name": "toHandle", "type": "string" }, { "name": "memo", "type": "string" }], "outputs": [], "stateMutability": "payable" },
  { "type": "function", "name": "receiptAt", "inputs": [{ "name": "i", "type": "uint256" }], "outputs": [{ "name": "", "type": "tuple", "components": [{ "name": "sender", "type": "address" }, { "name": "fromHandle", "type": "string" }, { "name": "toHandle", "type": "string" }, { "name": "token", "type": "address" }, { "name": "amount", "type": "uint256" }, { "name": "memo", "type": "string" }, { "name": "requestId", "type": "uint256" }, { "name": "timestamp", "type": "uint256" }] }], "stateMutability": "view" },
  { "type": "function", "name": "receiptCount", "inputs": [], "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view" },
  { "type": "function", "name": "stats", "inputs": [], "outputs": [{ "name": "totalPayments", "type": "uint256" }, { "name": "uniqueInteractors", "type": "uint256" }], "stateMutability": "view" },
  { "type": "error", "name": "NotAgentIdHolder", "inputs": [] },
  { "type": "error", "name": "UnknownHandle", "inputs": [{ "name": "handle", "type": "string" }] },
];

const REGISTRY_ABI = [
  { "type": "function", "name": "handleOf", "inputs": [{ "name": "account", "type": "address" }], "outputs": [{ "name": "", "type": "string" }], "stateMutability": "view" },
];

const ERC20_ABI = [
  { "type": "function", "name": "decimals", "inputs": [], "outputs": [{ "name": "", "type": "uint8" }], "stateMutability": "view" },
];

const $ = (id) => document.getElementById(id);

const state = {
  readContract: null,   // NamePay over JSON-RPC (public reads)
  usdtDecimals: 18,
  provider: null,       // BrowserProvider over the injected wallet
  signer: null,
  user: null,
  myHandle: null,
  paying: false,
};

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayHandle(h) {
  if (!h) return "—";
  return h.endsWith(".ai") ? h : h + ".ai";
}

function shortAddr(a) {
  return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—";
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

/* ------------------------------- public reads ---------------------------- */

async function initReads() {
  for (const url of CONFIG.READ_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const contract = new ethers.Contract(CONFIG.NAMEPAY_ADDRESS, NAMEPAY_ABI, provider);
      await contract.receiptCount(); // probe: first RPC that answers wins
      state.readContract = contract;
      try {
        const usdt = new ethers.Contract(CONFIG.USDT_ADDRESS, ERC20_ABI, provider);
        state.usdtDecimals = Number(await usdt.decimals());
      } catch { state.usdtDecimals = 18; }
      return true;
    } catch { /* try the next RPC */ }
  }
  return false;
}

async function loadStats() {
  if (!state.readContract) return;
  try {
    const [payments, interactors] = await state.readContract.stats();
    const n = Number(interactors);
    $("statPayments").textContent = String(payments);
    $("statInteractors").textContent = String(interactors);
    const pct = Math.min(100, (n / CONFIG.MILESTONE_INTERACTORS) * 100);
    $("progressFill").style.width = pct + "%";
    $("progressTrack").setAttribute("aria-valuenow", String(n));
    $("progressLabel").textContent = n >= CONFIG.MILESTONE_INTERACTORS
      ? `${n} of ${CONFIG.MILESTONE_INTERACTORS} Agent ID holders — milestone reached`
      : `${n} of ${CONFIG.MILESTONE_INTERACTORS} Agent ID holders — ${CONFIG.MILESTONE_INTERACTORS - n} more to reach the milestone`;
  } catch {
    $("progressLabel").textContent = "Live activity is unavailable right now.";
  }
}

async function loadWall() {
  const wall = $("wall");
  if (!state.readContract) {
    wall.innerHTML = '<p class="muted">Could not load the wall right now.</p>';
    return;
  }
  try {
    const count = Number(await state.readContract.receiptCount());
    if (count === 0) {
      wall.innerHTML = '<p class="muted">No payments yet. Be the first to pay a name.</p>';
      return;
    }
    const start = Math.max(0, count - CONFIG.WALL_LIMIT);
    const idx = [];
    for (let i = count - 1; i >= start; i--) idx.push(i);
    const receipts = await Promise.all(idx.map((i) => state.readContract.receiptAt(i)));
    wall.innerHTML = receipts.map((r) => {
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
  } catch {
    wall.innerHTML = '<p class="muted">Could not load the wall right now.</p>';
  }
}

async function refreshPublic() {
  await Promise.all([loadStats(), loadWall()]);
}

/* ------------------------------- wallet side ----------------------------- */

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

function refreshPayButton() {
  const btn = $("demoPayBtn");
  if (state.paying) {
    btn.disabled = true;
    btn.textContent = "Sending…";
    return;
  }
  if (!state.signer) {
    btn.disabled = false;
    btn.textContent = "Connect wallet to try";
    return;
  }
  if (!state.myHandle) {
    btn.disabled = true;
    btn.textContent = "An Agent ID is required";
    return;
  }
  btn.disabled = false;
  btn.textContent = `Send ${CONFIG.DEMO_AMOUNT_BNB} BNB to ${displayHandle(CONFIG.DEMO_HANDLE)}`;
}

async function setupSigner(address) {
  state.user = address;
  state.signer = await state.provider.getSigner();

  const network = await state.provider.getNetwork();
  const wrongChain = Number(network.chainId) !== CONFIG.CHAIN_ID;
  $("chainBanner").classList.toggle("hidden", !wrongChain);

  const chip = $("accountChip");
  chip.textContent = shortAddr(address);
  chip.classList.remove("hidden");
  $("connectBtn").textContent = "Connected";

  const registry = new ethers.Contract(CONFIG.REGISTRY_ADDRESS, REGISTRY_ABI, state.provider);
  let handle = "";
  try { handle = await registry.handleOf(address); } catch { handle = ""; }
  state.myHandle = handle || null;

  $("identityDisconnected").classList.add("hidden");
  if (state.myHandle) {
    $("identityHolder").classList.remove("hidden");
    $("identityNoId").classList.add("hidden");
    $("myHandle").textContent = displayHandle(state.myHandle);
    $("myAddress").textContent = address;
    try {
      const np = new ethers.Contract(CONFIG.NAMEPAY_ADDRESS, NAMEPAY_ABI, state.provider);
      const done = await np.hasInteracted(address);
      $("interactedNote").textContent = done
        ? "You have already used NamePay — your name is counted in the holder total."
        : "You have not used NamePay yet — this demo payment will add your name to the count.";
    } catch { $("interactedNote").textContent = ""; }
  } else {
    $("identityHolder").classList.add("hidden");
    $("identityNoId").classList.remove("hidden");
    $("myAddressNoId").textContent = address;
  }
  refreshPayButton();
}

async function connect() {
  if (!window.ethereum) {
    $("noWallet").classList.remove("hidden");
    return;
  }
  try {
    state.provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await state.provider.send("eth_requestAccounts", []);
    if (accounts && accounts.length > 0) await setupSigner(accounts[0]);
  } catch (e) {
    setStatus($("demoStatus"), "Connection was cancelled in your wallet — nothing was sent.", "error");
  }
}

function friendlyError(e) {
  const msg = (e && (e.shortMessage || e.message)) || String(e);
  if (e && (e.code === "ACTION_REJECTED" || e.code === 4001)) {
    return "You cancelled in your wallet — nothing was sent.";
  }
  if (msg.includes("NotAgentIdHolder")) {
    return "Your wallet does not hold an Agent ID, so NamePay cannot take the payment. Claim an Agent ID in the Binance App first.";
  }
  if (msg.includes("UnknownHandle")) {
    return "The demo name could not be resolved. Please try again in a moment.";
  }
  if (msg.toLowerCase().includes("insufficient funds")) {
    return "Your wallet does not have enough BNB for the dust payment plus gas.";
  }
  return "The payment did not go through: " + escapeHtml(msg.slice(0, 180));
}

async function doPay() {
  const statusEl = $("demoStatus");
  if (!state.signer) { await connect(); return; }
  if (!state.myHandle || state.paying) return;

  const network = await state.provider.getNetwork();
  if (Number(network.chainId) !== CONFIG.CHAIN_ID) {
    try { await switchChain(); } catch { /* chainChanged reload handles success */ }
    return;
  }

  state.paying = true;
  refreshPayButton();
  try {
    const np = new ethers.Contract(CONFIG.NAMEPAY_ADDRESS, NAMEPAY_ABI, state.signer);
    setStatus(statusEl, "Confirm the payment in your wallet…", "info");
    const tx = await np.payBNB(CONFIG.DEMO_HANDLE, CONFIG.DEMO_MEMO, {
      value: ethers.parseEther(CONFIG.DEMO_AMOUNT_BNB),
    });
    setStatus(statusEl, `Payment sent. ${txLink(tx.hash)} Waiting for confirmation…`, "info");
    await tx.wait();
    setStatus(
      statusEl,
      `Done — <strong>${escapeHtml(displayHandle(state.myHandle))}</strong> paid ` +
      `<strong>${escapeHtml(displayHandle(CONFIG.DEMO_HANDLE))}</strong> ${CONFIG.DEMO_AMOUNT_BNB} BNB. ` +
      `${txLink(tx.hash)} Your name is now on the wall below.`,
      "success"
    );
    await refreshPublic();
    try {
      const done = await np.hasInteracted(state.user);
      if (done) $("interactedNote").textContent = "You have now used NamePay — your name is counted in the holder total.";
    } catch { /* note is cosmetic */ }
  } catch (e) {
    setStatus(statusEl, friendlyError(e), "error");
  } finally {
    state.paying = false;
    refreshPayButton();
  }
}

/* --------------------------------- init ---------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
  $("contractLink").textContent = CONFIG.NAMEPAY_ADDRESS;
  $("contractLink").href = CONFIG.BSCSCAN_BASE + "/address/" + CONFIG.NAMEPAY_ADDRESS;

  // Public reads first: stats + wall must work with no wallet at all.
  const ok = await initReads();
  if (ok) {
    await refreshPublic();
    setInterval(refreshPublic, 30000);
  } else {
    $("progressLabel").textContent = "Live activity is unavailable right now.";
    $("wall").innerHTML = '<p class="muted">Could not load the wall right now.</p>';
  }

  if (!window.ethereum) {
    $("noWallet").classList.remove("hidden");
    $("demoPayBtn").disabled = true;
    $("demoPayBtn").textContent = "Open in a wallet browser to try";
    return;
  }

  state.provider = new ethers.BrowserProvider(window.ethereum);
  window.ethereum.on("chainChanged", () => window.location.reload());
  window.ethereum.on("accountsChanged", () => window.location.reload());

  $("connectBtn").addEventListener("click", connect);
  $("switchChainBtn").addEventListener("click", async () => {
    try { await switchChain(); } catch { /* chainChanged reload handles success */ }
  });
  $("demoPayBtn").addEventListener("click", doPay);

  // Restore an already-authorized session without prompting.
  try {
    const accounts = await state.provider.listAccounts();
    if (accounts && accounts.length > 0) await setupSigner(accounts[0].address);
  } catch { /* stay disconnected */ }

  refreshPayButton();
});
