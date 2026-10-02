# Monad / Perpl Execution Plan

> Status: frozen implementation guidance for the `hackathon/monad` branch.  
> Scope: define the minimum Perpl execution boundary; do not redesign Trading Core.

## 1. Purpose and boundary

This document unifies the Monad / Perpl branch direction, the Perpl Integration Reality Check, and the venue-independent findings from the Execution Reality Audit. It is the gate for subsequent implementation work.

The target architecture remains:

```text
Existing Trading Core
        ↓
Perpl Adapter
        ↓
Perpl execution semantics
        ↓
Recovery / Reconciliation
```

The Core continues to own Strategy, Risk, OrderTracker, PositionBook, Recovery, and Reconciliation. It must not know about Perpl wire types, `rq`, `sn`, `cid`, WalletFill messages, or Monad transactions. All protocol translation and evidence admission belongs to the Perpl Adapter.

This plan deliberately does not introduce cross margin, multi-DEX abstractions, raw blockchain transaction tracking, a finality engine, an event-sourcing rewrite, autonomous AI trading, a complex frontend, or a generic Web3 framework.

## 2. Frozen execution principles

### 2.1 Intent is not fact

The execution boundary must preserve these distinct evidence classes:

```text
LOCAL_INTENT
        ↓
COMMAND_OUTCOME
        ↓
ORDER_FACT
        ↓
EXECUTION_FACT
        ↓
ACCOUNT_SNAPSHOT
```

The arrows express possible progression and correlation, not equivalence. In particular:

```text
submit success       != order success
command accepted     != order open
command accepted     != fill
cancel requested     != order canceled
cancel accepted      != margin released
local state          != venue reality
```

Transport completion only proves that a transport operation completed. A command outcome reports the disposition of a request. An order fact reports the venue's order state. An execution fact proves a fill. An account snapshot reports account state for its stated scope and point in time. No earlier class may manufacture a later one.

### 2.2 Core does not manufacture venue facts

The Core may create intent and maintain a local mirror, but it cannot declare that Perpl accepted, opened, changed, canceled, or filled an order. PositionBook changes only from an admitted execution fact. OrderTracker changes only from normalized facts emitted across the execution boundary.

The Perpl Adapter is responsible for:

- authentication and authenticated stream handling;
- Perpl command construction;
- identity allocation and translation;
- protocol message validation;
- provenance capture;
- deduplication and correlation before Core delivery;
- snapshot normalization;
- detecting gaps or insufficient evidence and failing closed.

The Adapter must not make Strategy or Risk decisions, calculate an alternative position ledger, or create a second recovery system.

### 2.3 Commands and events are separate

A Post invocation returning successfully is not a Core `ORDER_ACK`. A successful Command Status is not a fill. The Adapter may emit a Core execution event only when the corresponding Perpl evidence class supports that event.

For Phase 1:

- an authoritative Order Update or equivalent order fact establishes the protocol order identity and may become `ORDER_ACK`;
- a WalletFill with a valid native fill identity may become `FILL`;
- snapshots establish or reconcile a mirror but must not be presented as a fabricated live event without an explicit normalization rule.

If facts arrive out of the order expected by the current Core, the Adapter must correlate and buffer them, or stop for reconciliation. It must not weaken evidence merely to satisfy local event ordering.

### 2.4 Identity translation belongs to the Adapter

Core identities remain unchanged:

```text
clientOrderId
exchangeOrderId
fillId
```

Perpl identities are adapter-owned:

```text
rq
sn
cid
protocolOrderId
nativeFillId
```

The frozen mapping is:

```text
Order identity
clientOrderId <-> protocolOrderId

Command correlation
clientOrderId -> one or more rq values
clientOrderId -> sn -> echoed cid

Execution identity
protocolOrderId -> one or more nativeFillId values
```

The normalized Core mapping is:

```text
exchangeOrderId = protocolOrderId
fillId          = nativeFillId
```

The following mappings are forbidden:

```text
rq     = permanent order identity
sn/cid = permanent protocol order identity
fillId = locally synthesized arrival counter
```

`rq` is a strictly increasing Perpl request identifier and idempotency key. It identifies a command, so Post, Change, and Cancel for one order can require different `rq` values. `sn` is the non-zero client-provided sequence echoed as `cid`; it is correlation evidence, not a substitute for the protocol order identity.

Identity allocation and the mapping journal must be durable before the command crosses the venue boundary. Retry behavior must reuse or advance `rq` only according to verified Perpl command semantics; a generic retry wrapper is prohibited.

### 2.5 State provenance is required for adjudication

Any fact used to change trading state or clear a recovery gate must answer:

```text
Who reported it?
Which venue and account does it describe?
What is its native identity?
Is it a snapshot or a delta?
What external timestamp, sequence, cursor, or as-of scope applies?
Has this native fact already been processed?
Can it be mapped to an internal intent?
```

Initial Monad provenance sources are:

```text
venue = PERPL

source = COMMAND_STATUS
       | ORDER_UPDATE
       | WALLET_FILL
       | ORDERS_SNAPSHOT
       | POSITIONS_SNAPSHOT
       | WALLET_SNAPSHOT
```

The concrete evidence envelope will be named `PerplExecutionEvidence`. It must use Perpl-native semantics rather than copied Binance DTOs, user-stream fields, or trade-update schemas. Its minimum conceptual content is:

- venue and account identity;
- source kind;
- native request, order, or fill identity as applicable;
- internal correlation when established;
- snapshot/delta classification and completeness scope;
- available external timestamp, sequence, cursor, or as-of value;
- local receive time for diagnostics only;
- deduplication/admission disposition.

Local receive order is not a substitute for Perpl execution order. Absence from an incomplete or unscoped response is not proof of a terminal state.

### 2.6 Authoritative facts remain fact-specific

No single message type is the source of truth for every question:

| Perpl source | Can establish | Cannot establish by itself |
| --- | --- | --- |
| Command Status | Outcome of the identified `rq` | Fill, current order set, current position, or margin release |
| Order Update | State of the identified protocol order | A complete account view or complete execution history |
| WalletFill | A native execution fact and its fill identity | Completeness of the order set or account snapshot |
| OrdersSnapshot | Orders within its declared complete scope and as-of point | Why an absent order disappeared or complete fill economics |
| PositionsSnapshot | Position state within its scope and as-of point | Which intent or fill caused that state |
| WalletSnapshot | Wallet/account values within its scope and as-of point | Success of a particular Post/Cancel or causal margin release |

Contradictory, incomplete, uncorrelated, duplicated, or gap-affected evidence must not be guessed into consistency.

### 2.7 Reconciliation and recovery remain Core capabilities

The Adapter obtains and normalizes Perpl evidence. Existing Reconciliation compares the local mirror with normalized venue facts. Recovery decides how to converge only after evidence is sufficient. Reconciliation must remain read-only until a separately reviewed convergence rule exists.

An unresolved command, stream gap, unknown identity, conflicting fact, or unprovable terminal state must produce a fail-closed outcome such as `HALT` or recovery required. It must not silently restore trading eligibility.

## 3. `PerplExecutionEvidence` design boundary

`PerplExecutionEvidence` is an adapter-level evidence model, not a replacement for Core `ExecutionEvent`. It preserves enough native context to audit admission and build snapshots while preventing Perpl fields from leaking into Core.

Its responsibilities are:

1. retain the original evidence class and Perpl source;
2. retain stable native identities without renaming them into misleading Core concepts;
3. record account and temporal/sequence scope;
4. express whether internal intent correlation has been established;
5. support native-identity deduplication;
6. record why evidence was admitted, buffered, quarantined, or rejected;
7. permit deterministic normalization into Core events or reconciliation inputs.

It must not:

- declare an order or fill merely because a command was accepted;
- use `rq` or `cid` as `exchangeOrderId` without protocol proof;
- invent fill identities;
- overwrite PositionBook directly;
- encode Binance-specific fields for superficial schema consistency;
- treat a Monad transaction receipt as sufficient trading truth in Phase 1.

## 4. Hackathon delivery plan

The working schedule assumes approximately 11 days remain before submission. Scope discipline is therefore part of execution safety: no new capability is added until the preceding phase produces its required evidence.

### Phase 0 — Execution Reality Alignment

**Goal:** freeze the implementation boundary and establish whether real Perpl access is feasible.

**Deliverables:**

- this execution plan;
- a completed Access Reality checklist;
- recorded blockers with evidence rather than assumptions;
- a go/no-go decision for real Phase 1 trading.

**Exit condition:** the team can identify the available environment, account, authentication flow, collateral path, snapshots, event streams, and trading permissions. Documentation alone does not satisfy the access gate.

### Phase 1 — One real Perpl Order Lifecycle (required)

**Goal:** connect one existing Core intent to one real, authoritative Perpl lifecycle.

```text
Authentication
        ↓
Snapshot Reader
        ↓
durable rq/sn allocation
        ↓
Post command
        ↓
Order Update
        ↓
WalletFill
        ↓
Core ExecutionEvent
```

**Minimum implementation scope:**

- authenticate one account;
- read WalletSnapshot, OrdersSnapshot, and PositionsSnapshot;
- durably allocate and correlate `rq` and `sn/cid`;
- send one Post command using an existing `SubmitOrderCommand`;
- establish `protocolOrderId` from authoritative order evidence;
- translate it to Core `exchangeOrderId`;
- admit one WalletFill using its `nativeFillId` as Core `fillId`;
- deliver normalized `ORDER_ACK` and `FILL` to the existing OrderTracker;
- observe the existing PositionBook update;
- retain sufficient `PerplExecutionEvidence` to explain each transition.

**Success criterion:**

```text
Intent
→ Perpl command
→ authoritative order fact
→ execution fact
→ Position update
```

Transport success, Command Status alone, a locally fabricated event, or a snapshot-only simulated position does not satisfy Phase 1.

### Phase 2 — Real execution failure evidence (core delivery)

**Goal:** demonstrate one real execution failure rather than expand feature breadth.

Target case:

```text
Cancel
→ separate Post
→ margin release dependency
→ Order Update sr reason
→ HALT
→ preserved evidence
```

The trace must record, where applicable:

```text
Intent
Command
rq
Order Update
sr
Fill
Snapshot
```

The acceptance criterion is not merely receiving an error. The system must demonstrate that it:

1. does not equate cancel intent or command acceptance with margin release;
2. observes and preserves the Perpl order-update `sr` reason;
3. halts risk expansion instead of inventing success;
4. retains correlated evidence sufficient to explain the failure;
5. obtains snapshots needed to compare local state with venue reality.

If real failure evidence is not obtained, stop and report the evidence gap. Do not compensate by adding more order types, chains, strategies, abstractions, or UI.

### Phase 3 — Optional follow-up

Only after Phases 1 and 2 are evidenced:

- compare Change with separate Cancel → Post;
- automate a narrowly reviewed recovery path;
- deepen reconciliation for demonstrated mismatches;
- polish the demo and evidence presentation.

Phase 3 does not block the foundational submission and must not displace Phase 1 or Phase 2.

## 5. Phase 0 Access Reality result

Audit date: 2026-10-02. This result describes the current execution environment, not the general availability of the Perpl API.

### 5.1 Access matrix

| Capability | Status | Evidence |
| --- | --- | --- |
| API authentication | **BLOCKED** | Perpl documents mainnet `https://app.perpl.xyz/api` and testnet `https://testnet.perpl.xyz/api`. Requests use an enrolled Ed25519 API key and four `X-API-*` headers; the canonical signature covers chain ID, method, exact target, timestamp, nonce, and body hash. TypeScript can use built-in `fetch` plus `@noble/ed25519`. In this environment `PERPL_API_KEY` and `PERPL_API_KEY_SECRET` are unset, `@noble/ed25519` is not installed, and even unauthenticated `/v1/pub/context` probes are rejected by the outbound proxy with HTTP tunnel 403. |
| Account | **BLOCKED** | API-key enrollment does not create an exchange account. API trading requires an on-chain account created with `createAccount(...)`, plus `allowOrderForwarding(true)`. The forwarding state is reported as `Account.fw`. This environment has no wallet address/key, account ID, authenticated WalletSnapshot, or evidence that forwarding is enabled. |
| Collateral | **UNKNOWN** | Official network configuration identifies mainnet AUSD at `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` and testnet USD at `0xdf5b718d8fcc173335185a2a1513ee8151e3c027`. The current minimum must be read from public context (`ProtocolInstance.min_account_open_amount`); the documented `10.0 AUSD` is explicitly an example, not a frozen minimum. No official testnet faucet or other acquisition path was verified, and no balance is available in this environment. |
| Snapshot | **BLOCKED** | Official authenticated REST paths exist for wallet, open orders, and open positions. No enrolled key/account is configured, and network policy prevents a live response, so WalletSnapshot, OrdersSnapshot, and PositionsSnapshot have not been observed for the target account. |
| WebSocket | **BLOCKED** | Official trading WebSocket endpoints are `wss://app.perpl.xyz/ws/v1/trading` and `wss://testnet.perpl.xyz/ws/v1/trading`; sign-in uses an Ed25519-signed `ApiKeySignIn` frame. The documented stream includes command status, order updates, fills, and initial account state, but this environment lacks credentials and network reachability, so none has been authenticated or observed. |
| Trading | **BLOCKED** | A real API lifecycle requires a trade-scoped key, exchange account, collateral, `fw=true`, authenticated trading WebSocket, and a bounded test order. None of those account-specific prerequisites is evidenced here. |

Authoritative documentation used for this audit:

- [Perpl API documentation](https://github.com/PerplFoundation/api-docs)
- [Perpl Type Reference](https://github.com/PerplFoundation/api-docs/blob/main/types.md)
- [Perpl TypeScript quickstart](https://github.com/PerplFoundation/perpl-docs/blob/main/docs/resources/for-developers/quickstart.md)

### 5.2 API and account reality

The interface is available in the product documentation, but it is not usable from the current environment:

```text
REST mainnet:  https://app.perpl.xyz/api
REST testnet:  https://testnet.perpl.xyz/api
WS mainnet:    wss://app.perpl.xyz/ws/v1/trading
WS testnet:    wss://testnet.perpl.xyz/ws/v1/trading
```

Required authentication and TypeScript runtime pieces are:

```text
enrolled X-API-Key token
+ 32-byte Ed25519 private key
+ chain ID
+ @noble/ed25519
+ Node.js fetch / crypto
+ WebSocket client
```

The account prerequisites are separate and cumulative:

```text
wallet-signed API-key enrollment with trade scope
+ createAccount(initial collateral)
+ allowOrderForwarding(true)
+ Account.fw observed as true
```

Authentication success alone therefore cannot make the account READY.

### 5.3 `rq` and identity reality

The official `Account` type contains:

```text
lfr: RequestID // last forwarded request ID; seed rq generation from it
```

Therefore a future allocator must initialize from the authenticated WalletSnapshot/account update rather than start at an arbitrary local constant. The next new command must satisfy the documented per-account monotonic/idempotency rule and must account for the maximum durable local allocation as well as venue-reported `lfr`. Exact retry reuse must follow Perpl's at-most-once rules; this audit does not implement it.

`sn` is the client sequence echoed as response `cid`. It must be retained with the in-flight request if correlation must survive reconnect or restart, but it is not the permanent order identity.

The authoritative order object supplies `oid` (`OrderID`) and also exposes `scid` (smart-contract order ID); fills refer to `oid`. The first implementation must confirm these values in a real Order Update/WalletFill before choosing the normalized `protocolOrderId`. It must not substitute `rq`, `sn`, or `cid` for that observation.

### 5.4 Gate decision and local fallback

```text
BLOCKER

Impact:
Cannot start real order lifecycle.

Fallback:
Only non-trading preparation is safe: provision credentials/account access outside
the repository, restore endpoint reachability, and run read-only authenticated
snapshot/WebSocket probes. Do not implement a mock adapter, Post command, or order logic.
```

The gate may change to READY only after live evidence shows all of the following for the intended account:

- authenticated WalletSnapshot, OrdersSnapshot, and PositionsSnapshot;
- a trade-scoped API key and successful authenticated WebSocket sign-in;
- an existing funded account with `fw=true`;
- verified current collateral minimum and an actual collateral acquisition path;
- observed initial `lfr` and the relevant command/order/fill message shapes;
- permission and loss bounds for one real test order.

## 6. Implementation gates

### Gate A — before any Perpl execution code

- Phase 0 Access Reality checklist has evidence-backed answers.
- The target account/environment and safe order size are fixed.
- `rq` allocation and retry semantics are confirmed.
- `sn/cid` and protocol order identity semantics are confirmed from actual Perpl behavior or authoritative documentation.

### Gate B — before emitting a Core event

- source and account are authenticated;
- native identity is present and valid for that fact class;
- internal intent correlation is established;
- duplicate processing has been checked;
- required symbol, side, quantity, and order identity invariants pass;
- any ordering gap or contradictory evidence has been ruled out or escalated.

### Gate C — before Phase 2 expansion

- Phase 1 completes against real Perpl evidence;
- PositionBook changes exactly once for the native fill;
- snapshots reconcile the demonstrated lifecycle, or mismatches are explicitly recorded;
- the evidence trace can distinguish intent, command outcome, order fact, execution fact, and account snapshot.

## 7. Stop conditions

Stop implementation and report a blocker when:

- authentication cannot be established;
- no usable account or collateral path exists;
- the intended test environment cannot trade;
- required snapshots or authenticated events cannot be obtained;
- `rq` retry/idempotency semantics remain ambiguous;
- `sn/cid` cannot be reliably correlated to a protocol order identity;
- evidence cannot distinguish command acceptance from order or execution facts;
- the only proposed solution requires changing Strategy, Risk, PositionBook, margin semantics, or introducing a second state system.

The correct response to a failed access or evidence gate is a precise blocker, not speculative adapter code.
