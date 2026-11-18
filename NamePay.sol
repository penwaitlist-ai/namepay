// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal read-only view of the SPACE ID Agent ID registry
///         (ERC-721, non-transferable) deployed on BNB Chain at
///         0x60b9262456de011f7d15a54cdd8c48baaa8b022f.
/// @dev NamePay only ever READS from the registry: it never approves,
///      transfers or otherwise touches anyone's Agent ID.
interface IAgentIdRegistry {
    /// @notice Number of Agent IDs held by `account` (0 or 1 in practice).
    function balanceOf(address account) external view returns (uint256);

    /// @notice The `.ai` handle owned by `account` (e.g. "ririn12.ai").
    function handleOf(address account) external view returns (string memory);

    /// @notice The address that owns `handle`, or address(0) if unregistered.
    function ownerOfHandle(string calldata handle) external view returns (address);
}

/// @notice The only ERC-20 surface NamePay needs.
interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title NamePay — pay a name, not an address
/// @notice "Venmo for Agent ID": send BNB or any ERC-20 token to a human
///         readable `.ai` handle (e.g. `ririn12.ai`). NamePay resolves the
///         handle to its owner's address through the Agent ID registry and
///         forwards the funds to that owner inside the SAME transaction,
///         leaving a public, handle-bound payment receipt on-chain.
///
/// @dev NO-CUSTODY PROPERTY: this contract never holds funds. BNB is
///      forwarded with a plain call in the same transaction that receives
///      it, and tokens move directly from sender to recipient via
///      `transferFrom`. There is deliberately:
///
///        - NO owner and NO admin functions of any kind,
///        - NO pause, NO upgrade mechanism, NO withdraw function,
///        - NO `receive()`/`fallback()`, so stray plain BNB transfers to
///          this contract revert instead of getting stuck in it.
///
///      If a forward ever fails, the whole transaction reverts, so funds
///      can never end up parked here.
///
///      HOLDER GATE: every state-changing function requires the caller to
///      hold an Agent ID (`registry.balanceOf(msg.sender) > 0`). As a
///      result, every address that ever interacts with NamePay is, by
///      construction, a verified Agent ID holder address.
///
///      REENTRANCY: payment functions record all state (receipt, request
///      status, interactor set) BEFORE making any external call
///      (checks-effects-interactions) AND are protected by a mutex, so a
///      malicious recipient contract cannot re-enter mid-payment.
contract NamePay {
    /// @notice Maximum byte length of a handle argument.
    uint256 public constant MAX_HANDLE_BYTES = 64;

    /// @notice Maximum byte length of a memo / note argument.
    uint256 public constant MAX_TEXT_BYTES = 140;

    /// @notice The Agent ID registry this deployment resolves names through.
    /// @dev Immutable and set once at deployment. On BNB Chain mainnet this
    ///      is 0x60b9262456de011f7d15a54cdd8c48baaa8b022f. It is a constructor
    ///      argument (not hard-coded) so tests can inject a mock registry,
    ///      and so the deployer cannot be impersonated: the contract has no
    ///      owner, so whoever deploys it gains no privileges whatsoever.
    IAgentIdRegistry public immutable registry;

    /// @notice One settled payment. `token == address(0)` means BNB.
    /// @param sender     Address that paid (always an Agent ID holder).
    /// @param fromHandle Sender's `.ai` handle, read from the registry.
    /// @param toHandle   Recipient's `.ai` handle (for request payments:
    ///                   the request creator's handle).
    /// @param token      ERC-20 token address, or address(0) for BNB.
    /// @param amount     Amount paid, in the asset's smallest unit.
    /// @param memo       Free-text memo (for request payments: the
    ///                   request's note).
    /// @param requestId  Id of the payment request this settles, or 0 for a
    ///                   direct payment. (Request ids start at 0 too; a
    ///                   receipt with requestId 0 is a direct payment unless
    ///                   a RequestPaid event for id 0 exists — see
    ///                   DESIGN-NOTES.md.)
    /// @param timestamp  Block timestamp of the payment.
    struct Receipt {
        address sender;
        string fromHandle;
        string toHandle;
        address token;
        uint256 amount;
        string memo;
        uint256 requestId;
        uint256 timestamp;
    }

    /// @notice A shareable payment request created by a handle owner.
    /// @param creator       Address that created the request.
    /// @param creatorHandle Creator's `.ai` handle at creation time.
    /// @param token         Token asked for; address(0) means BNB.
    /// @param amount        Exact amount asked for.
    /// @param note          Free-text note (becomes the receipt memo).
    /// @param paid          True once settled; a paid request can never be
    ///                      paid again.
    /// @param payer         Address that settled the request (0 until paid).
    struct PaymentRequest {
        address creator;
        string creatorHandle;
        address token;
        uint256 amount;
        string note;
        bool paid;
        address payer;
    }

    Receipt[] private _receipts;
    PaymentRequest[] private _requests;

    /// @dev Set of addresses that have performed at least one successful
    ///      state-changing interaction. Because of the holder gate, every
    ///      member of this set is an Agent ID holder address.
    mapping(address => bool) private _interacted;
    uint256 private _uniqueInteractors;

    /// @dev Reentrancy mutex: 1 = unlocked, 2 = locked.
    uint256 private _locked = 1;

    /// @notice Emitted for every settled payment (direct or via a request).
    event Payment(
        address indexed sender,
        string fromHandle,
        string toHandle,
        address token,
        uint256 amount,
        string memo,
        uint256 requestId
    );

    /// @notice Emitted when a payment request is created.
    event RequestCreated(uint256 id, string creatorHandle, address token, uint256 amount, string note);

    /// @notice Emitted when a payment request is settled.
    event RequestPaid(uint256 id, address payer);

    error NotAgentIdHolder();
    error UnknownHandle(string handle);
    error StringTooLong(uint256 length, uint256 max);
    error ZeroRegistry();
    error ZeroToken();
    error RequestNotFound(uint256 id);
    error RequestAlreadyPaid(uint256 id);
    error ValueMismatch(uint256 expected, uint256 actual);
    error ForwardFailed();
    error TokenTransferFailed();
    error ReentrantCall();

    /// @param agentIdRegistry Address of the Agent ID registry contract.
    constructor(address agentIdRegistry) {
        if (agentIdRegistry == address(0)) revert ZeroRegistry();
        registry = IAgentIdRegistry(agentIdRegistry);
    }

    // ------------------------------------------------------------------
    // Guards
    // ------------------------------------------------------------------

    /// @dev Holder gate: only Agent ID holders may change state.
    modifier onlyHolder() {
        if (registry.balanceOf(msg.sender) == 0) revert NotAgentIdHolder();
        _;
    }

    /// @dev Simple reentrancy mutex (defence in depth on top of CEI).
    modifier nonReentrant() {
        if (_locked != 1) revert ReentrantCall();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ------------------------------------------------------------------
    // Payments
    // ------------------------------------------------------------------

    /// @notice Pay BNB to a handle. The full `msg.value` is forwarded to
    ///         the handle's owner in this same transaction; NamePay keeps
    ///         nothing. If the forward fails, everything reverts.
    /// @param toHandle Recipient's `.ai` handle.
    /// @param memo     Optional memo (max 140 bytes).
    function payBNB(string calldata toHandle, string calldata memo) external payable onlyHolder nonReentrant {
        _checkLength(toHandle, MAX_HANDLE_BYTES);
        _checkLength(memo, MAX_TEXT_BYTES);
        address to = _resolve(toHandle);
        string memory fromHandle = registry.handleOf(msg.sender);

        // Effects before interactions.
        _markInteracted(msg.sender);
        _recordReceipt(msg.sender, fromHandle, toHandle, address(0), msg.value, memo, 0);
        emit Payment(msg.sender, fromHandle, toHandle, address(0), msg.value, memo, 0);

        // Interaction last: forward everything, keep nothing.
        (bool ok,) = to.call{value: msg.value}("");
        if (!ok) revert ForwardFailed();
    }

    /// @notice Pay an ERC-20 token to a handle. Tokens move directly from
    ///         the sender to the handle's owner via `transferFrom` (the
    ///         sender must have approved NamePay for at least `amount`).
    ///         NamePay never takes custody of the tokens.
    /// @param token    ERC-20 token address (address(0) is NOT valid here;
    ///                 use payBNB for BNB).
    /// @param toHandle Recipient's `.ai` handle.
    /// @param amount   Amount to send, in the token's smallest unit.
    /// @param memo     Optional memo (max 140 bytes).
    function payToken(address token, string calldata toHandle, uint256 amount, string calldata memo)
        external
        onlyHolder
        nonReentrant
    {
        if (token == address(0)) revert ZeroToken();
        _checkLength(toHandle, MAX_HANDLE_BYTES);
        _checkLength(memo, MAX_TEXT_BYTES);
        address to = _resolve(toHandle);
        string memory fromHandle = registry.handleOf(msg.sender);

        // Effects before interactions.
        _markInteracted(msg.sender);
        _recordReceipt(msg.sender, fromHandle, toHandle, token, amount, memo, 0);
        emit Payment(msg.sender, fromHandle, toHandle, token, amount, memo, 0);

        // Interaction last: pull tokens straight from sender to owner.
        _transferFrom(token, msg.sender, to, amount);
    }

    // ------------------------------------------------------------------
    // Payment requests
    // ------------------------------------------------------------------

    /// @notice Create a shareable payment request under your own handle.
    /// @param token  Token requested; address(0) means BNB.
    /// @param amount Exact amount requested.
    /// @param note   Optional note (max 140 bytes).
    /// @return id    The request id (share it as `?req=<id>`).
    function createRequest(address token, uint256 amount, string calldata note)
        external
        onlyHolder
        returns (uint256 id)
    {
        _checkLength(note, MAX_TEXT_BYTES);
        string memory creatorHandle = registry.handleOf(msg.sender);

        _markInteracted(msg.sender);

        id = _requests.length;
        _requests.push(
            PaymentRequest({
                creator: msg.sender,
                creatorHandle: creatorHandle,
                token: token,
                amount: amount,
                note: note,
                paid: false,
                payer: address(0)
            })
        );
        emit RequestCreated(id, creatorHandle, token, amount, note);
    }

    /// @notice Settle an open payment request. For a BNB request,
    ///         `msg.value` must equal the requested amount exactly and is
    ///         forwarded to the creator in this same transaction. For a
    ///         token request, the amount is pulled from you to the creator
    ///         via `transferFrom` and no BNB may be attached. Paying a
    ///         request that is already paid (or does not exist) reverts.
    /// @param id The request id to settle.
    function payRequest(uint256 id) external payable onlyHolder nonReentrant {
        if (id >= _requests.length) revert RequestNotFound(id);
        PaymentRequest storage req = _requests[id];
        if (req.paid) revert RequestAlreadyPaid(id);

        // Copy fields to memory before any state change / external call.
        address creator = req.creator;
        string memory creatorHandle = req.creatorHandle;
        address token = req.token;
        uint256 amount = req.amount;
        string memory note = req.note;

        // Effects before interactions: mark paid first, so even a
        // re-entrant call (blocked anyway by the mutex) could not settle
        // this request twice.
        req.paid = true;
        req.payer = msg.sender;
        _markInteracted(msg.sender);

        string memory fromHandle = registry.handleOf(msg.sender);
        _recordReceipt(msg.sender, fromHandle, creatorHandle, token, amount, note, id);
        emit Payment(msg.sender, fromHandle, creatorHandle, token, amount, note, id);
        emit RequestPaid(id, msg.sender);

        // Interaction last.
        if (token == address(0)) {
            if (msg.value != amount) revert ValueMismatch(amount, msg.value);
            (bool ok,) = creator.call{value: msg.value}("");
            if (!ok) revert ForwardFailed();
        } else {
            // Never accept stray BNB on a token settlement: this contract
            // must not end up holding funds it cannot forward.
            if (msg.value != 0) revert ValueMismatch(0, msg.value);
            _transferFrom(token, msg.sender, creator, amount);
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Total number of receipts (== total settled payments).
    function receiptCount() external view returns (uint256) {
        return _receipts.length;
    }

    /// @notice The receipt at index `i` (0-based, chronological).
    function receiptAt(uint256 i) external view returns (Receipt memory) {
        return _receipts[i];
    }

    /// @notice All receipts that involve `handle` — sent from it or paid
    ///         to it — in chronological order. Bounded linear scan; fine
    ///         for a hackathon-scale receipt log read off-chain.
    function receiptsOf(string calldata handle) external view returns (Receipt[] memory result) {
        bytes32 target = keccak256(bytes(handle));
        uint256 count = 0;
        for (uint256 i = 0; i < _receipts.length; i++) {
            if (_involves(_receipts[i], target)) count++;
        }
        result = new Receipt[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < _receipts.length; i++) {
            if (_involves(_receipts[i], target)) {
                result[j] = _receipts[i];
                j++;
            }
        }
    }

    /// @notice Total number of payment requests ever created.
    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    /// @notice The payment request with id `id`.
    function requestAt(uint256 id) external view returns (PaymentRequest memory) {
        if (id >= _requests.length) revert RequestNotFound(id);
        return _requests[id];
    }

    /// @notice Ids of all payment requests created under `handle`,
    ///         in creation order.
    function requestsOf(string calldata handle) external view returns (uint256[] memory ids) {
        bytes32 target = keccak256(bytes(handle));
        uint256 count = 0;
        for (uint256 i = 0; i < _requests.length; i++) {
            if (keccak256(bytes(_requests[i].creatorHandle)) == target) count++;
        }
        ids = new uint256[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < _requests.length; i++) {
            if (keccak256(bytes(_requests[i].creatorHandle)) == target) {
                ids[j] = i;
                j++;
            }
        }
    }

    /// @notice Headline counters: total settled payments and the number of
    ///         unique addresses that have ever interacted (all of them
    ///         Agent ID holders, by the holder gate).
    function stats() external view returns (uint256 totalPayments, uint256 uniqueInteractors) {
        return (_receipts.length, _uniqueInteractors);
    }

    /// @notice Whether `account` has ever successfully interacted.
    function hasInteracted(address account) external view returns (bool) {
        return _interacted[account];
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _resolve(string calldata handle) internal view returns (address owner) {
        owner = registry.ownerOfHandle(handle);
        if (owner == address(0)) revert UnknownHandle(handle);
    }

    function _checkLength(string calldata s, uint256 max) internal pure {
        uint256 len = bytes(s).length;
        if (len > max) revert StringTooLong(len, max);
    }

    function _markInteracted(address account) internal {
        if (!_interacted[account]) {
            _interacted[account] = true;
            _uniqueInteractors++;
        }
    }

    function _recordReceipt(
        address sender,
        string memory fromHandle,
        string memory toHandle,
        address token,
        uint256 amount,
        string memory memo,
        uint256 requestId
    ) internal {
        _receipts.push(
            Receipt({
                sender: sender,
                fromHandle: fromHandle,
                toHandle: toHandle,
                token: token,
                amount: amount,
                memo: memo,
                requestId: requestId,
                timestamp: block.timestamp
            })
        );
    }

    function _involves(Receipt storage r, bytes32 handleHash) internal view returns (bool) {
        return keccak256(bytes(r.fromHandle)) == handleHash || keccak256(bytes(r.toHandle)) == handleHash;
    }

    /// @dev transferFrom via a low-level call so that tokens which return
    ///      no value (old-style) are accepted, while an explicit `false`
    ///      or a reverting token both fail the payment. Any failure
    ///      reverts the whole transaction, undoing the receipt above.
    function _transferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!ok) revert TokenTransferFailed();
        if (ret.length != 0 && !abi.decode(ret, (bool))) revert TokenTransferFailed();
    }
}
