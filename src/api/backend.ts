/**
 * Backend REST API client for Hyperion transfer tracking and claims.
 *
 * Communicates with the Fastify backend endpoints:
 * - GET /v1/transfers
 * - GET /v1/transfers/:originChain/:nonce
 * - GET /v1/transfers/by-tx/:txHash
 * - GET /v1/claims
 * - GET /v1/claims/:chain/:claimId
 *
 * Provides typed models matching the backend database schema, with deterministic
 * fallback testnet fixtures when running offline or without an active replica.
 */

export type TransferLifecycleStage =
  | "initiated"
  | "attesting"
  | "attested"
  | "delivering"
  | "delivered"
  | "parked"
  | "settled"
  | "failed";

export interface FormattedTransfer {
  readonly id: string;
  readonly stage: TransferLifecycleStage;
  readonly route: number;
  readonly origin: {
    readonly chain: string;
    readonly nonce: string;
    readonly sender: string;
    readonly token: string;
    readonly grossAmount: string;
    readonly fee: string;
    readonly netAmount: string;
    readonly block: string;
    readonly txHash: string;
    readonly observedAt: string;
  };
  readonly destination: {
    readonly chain: string;
    readonly recipient: string;
    readonly delivered: boolean;
    readonly block: string | null;
    readonly txHash: string | null;
    readonly deliveredAt: string | null;
  };
  readonly rail: {
    readonly status: string | null;
    readonly railStatus: string | null;
    readonly reference: string | null;
    readonly attestedAt: string | null;
    readonly lastError: string | null;
  } | null;
  readonly claim: {
    readonly id: string;
    readonly settled: boolean;
  } | null;
}

export interface FormattedClaim {
  readonly id: string;
  readonly chain: string;
  readonly claimId: string;
  readonly recipient: string;
  readonly token: string;
  readonly amount: string;
  readonly route: number;
  readonly sourceChain: string;
  readonly sourceNonce: string;
  readonly settled: boolean;
  readonly createdAt: string;
  readonly observedAt: string;
}

export interface TransfersResponse {
  readonly transfers: readonly FormattedTransfer[];
  readonly limit: number;
  readonly offset: number;
  readonly count: number;
}

export interface ClaimsResponse {
  readonly claims: readonly FormattedClaim[];
  readonly limit: number;
  readonly offset: number;
  readonly count: number;
}

export interface TransfersQuery {
  readonly originChain?: string;
  readonly destinationChain?: string;
  readonly route?: string;
  readonly sender?: string;
  readonly recipient?: string;
  readonly limit?: string;
  readonly offset?: string;
  readonly search?: string;
}

export interface ClaimsQuery {
  readonly chain?: string;
  readonly recipient?: string;
  readonly settled?: string;
  readonly limit?: string;
  readonly offset?: string;
}

export function getRouteName(route: number): string {
  switch (route) {
    case 0:
      return "CCTP";
    case 1:
      return "Axelar ITS";
    case 2:
      return "Axelar GMP";
    case 3:
      return "Allbridge";
    default:
      return `Route ${route}`;
  }
}

/** Fallback testnet fixture transfers representing live multi-rail states. */
export const FIXTURE_TRANSFERS: readonly FormattedTransfer[] = [
  {
    id: "1",
    stage: "delivered",
    route: 1,
    origin: {
      chain: "stellar-testnet",
      nonce: "104",
      sender: "GA6XCMZIV34L3S2Z54EAMQZMNP2KYYA7W25L6H34Z7R3L2",
      token: "USDC",
      grossAmount: "100.0000000",
      fee: "0.1000000",
      netAmount: "99.9000000",
      block: "4966620",
      txHash: "0x3a4b7f91c8e26d0481fa39b7829dc74828392019485720194827392819482910",
      observedAt: "2026-10-07T12:00:00.000Z",
    },
    destination: {
      chain: "arc-testnet",
      recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      delivered: true,
      block: "1849204",
      txHash: "0x89ab12cd34ef5678901234567890123456789012345678901234567890abcdef",
      deliveredAt: "2026-10-07T12:02:15.000Z",
    },
    rail: {
      status: "attested",
      railStatus: "executed",
      reference: "0xaxelar_ref_104",
      attestedAt: "2026-10-07T12:01:40.000Z",
      lastError: null,
    },
    claim: null,
  },
  {
    id: "2",
    stage: "attesting",
    route: 0,
    origin: {
      chain: "stellar-testnet",
      nonce: "105",
      sender: "GB7XCMZIV34L3S2Z54EAMQZMNP2KYYA7W25L6H34Z7R3L3",
      token: "USDC",
      grossAmount: "250.0000000",
      fee: "0.2500000",
      netAmount: "249.7500000",
      block: "4966750",
      txHash: "0x7b2c5d8819a34e0283c4819d7e5f102839485019283746592019384756281902",
      observedAt: "2026-10-07T14:15:00.000Z",
    },
    destination: {
      chain: "arbitrum-sepolia",
      recipient: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      delivered: false,
      block: null,
      txHash: null,
      deliveredAt: null,
    },
    rail: {
      status: "pending",
      railStatus: "attesting",
      reference: "0xcctp_nonce_105",
      attestedAt: null,
      lastError: null,
    },
    claim: null,
  },
  {
    id: "3",
    stage: "delivering",
    route: 3,
    origin: {
      chain: "stellar-testnet",
      nonce: "106",
      sender: "GC8XCMZIV34L3S2Z54EAMQZMNP2KYYA7W25L6H34Z7R3L4",
      token: "USDC",
      grossAmount: "50.0000000",
      fee: "0.0500000",
      netAmount: "49.9500000",
      block: "4966810",
      txHash: "0x1f2e3d4c5b6a7089102938475610293847561029384756102938475610293847",
      observedAt: "2026-10-07T15:30:00.000Z",
    },
    destination: {
      chain: "base-sepolia",
      recipient: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      delivered: false,
      block: null,
      txHash: null,
      deliveredAt: null,
    },
    rail: {
      status: "attested",
      railStatus: "confirmed",
      reference: "0xallbridge_106",
      attestedAt: "2026-10-07T15:31:10.000Z",
      lastError: null,
    },
    claim: null,
  },
  {
    id: "4",
    stage: "parked",
    route: 2,
    origin: {
      chain: "stellar-testnet",
      nonce: "107",
      sender: "GD9XCMZIV34L3S2Z54EAMQZMNP2KYYA7W25L6H34Z7R3L5",
      token: "USDC",
      grossAmount: "500.0000000",
      fee: "0.5000000",
      netAmount: "499.5000000",
      block: "4966900",
      txHash: "0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
      observedAt: "2026-10-07T16:00:00.000Z",
    },
    destination: {
      chain: "ethereum-sepolia",
      recipient: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
      delivered: false,
      block: "6120400",
      txHash: "0x55aa22bb33cc44dd55ee66ff77889900aabbccddeeff00112233445566778899",
      deliveredAt: "2026-10-07T16:05:00.000Z",
    },
    rail: {
      status: "attested",
      railStatus: "executed",
      reference: "0xaxelar_gmp_107",
      attestedAt: "2026-10-07T16:04:30.000Z",
      lastError: null,
    },
    claim: {
      id: "107",
      settled: false,
    },
  },
  {
    id: "5",
    stage: "settled",
    route: 1,
    origin: {
      chain: "stellar-testnet",
      nonce: "102",
      sender: "GA6XCMZIV34L3S2Z54EAMQZMNP2KYYA7W25L6H34Z7R3L2",
      token: "USDC",
      grossAmount: "1200.0000000",
      fee: "1.2000000",
      netAmount: "1198.8000000",
      block: "4966400",
      txHash: "0x4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e",
      observedAt: "2026-10-07T10:10:00.000Z",
    },
    destination: {
      chain: "arc-testnet",
      recipient: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4df",
      delivered: false,
      block: "1849100",
      txHash: "0x2233445566778899aabbccddeeff00112233445566778899aabbccddeeff0011",
      deliveredAt: "2026-10-07T10:12:00.000Z",
    },
    rail: {
      status: "attested",
      railStatus: "executed",
      reference: "0xaxelar_ref_102",
      attestedAt: "2026-10-07T10:11:30.000Z",
      lastError: null,
    },
    claim: {
      id: "102",
      settled: true,
    },
  },
];

export const FIXTURE_CLAIMS: readonly FormattedClaim[] = [
  {
    id: "1",
    chain: "ethereum-sepolia",
    claimId: "107",
    recipient: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    token: "USDC",
    amount: "499.5000000",
    route: 2,
    sourceChain: "stellar-testnet",
    sourceNonce: "107",
    settled: false,
    createdAt: "2026-10-07T16:05:00.000Z",
    observedAt: "2026-10-07T16:05:02.000Z",
  },
  {
    id: "2",
    chain: "arc-testnet",
    claimId: "102",
    recipient: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4df",
    token: "USDC",
    amount: "1198.8000000",
    route: 1,
    sourceChain: "stellar-testnet",
    sourceNonce: "102",
    settled: true,
    createdAt: "2026-10-07T10:12:00.000Z",
    observedAt: "2026-10-07T10:12:05.000Z",
  },
];

function getApiBaseUrl(): string {
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_HYPERION_API_URL) {
    return process.env.NEXT_PUBLIC_HYPERION_API_URL.replace(/\/$/, "");
  }
  if (typeof process !== "undefined" && process.env.NEXT_PUBLIC_HYPERION_INDEXER_URL) {
    return process.env.NEXT_PUBLIC_HYPERION_INDEXER_URL.replace(/\/$/, "");
  }
  return "http://localhost:4000";
}

/**
 * Query transfer records with optional filters.
 *
 * Attempts the backend endpoint first and falls back to fixture data if unreachable.
 */
export async function fetchTransfers(query?: TransfersQuery): Promise<TransfersResponse> {
  const params = new URLSearchParams();
  if (query?.originChain) params.set("originChain", query.originChain);
  if (query?.destinationChain) params.set("destinationChain", query.destinationChain);
  if (query?.route !== undefined) params.set("route", query.route);
  if (query?.sender) params.set("sender", query.sender);
  if (query?.recipient) params.set("recipient", query.recipient);
  if (query?.limit) params.set("limit", query.limit);
  if (query?.offset) params.set("offset", query.offset);

  const qs = params.toString();
  const url = `${getApiBaseUrl()}/v1/transfers${qs ? `?${qs}` : ""}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      return (await res.json()) as TransfersResponse;
    }
  } catch {
    // Backend offline; apply local query filtering to fixtures
  }

  let list = [...FIXTURE_TRANSFERS];
  if (query?.search) {
    const q = query.search.toLowerCase();
    list = list.filter(
      (t) =>
        t.origin.txHash.toLowerCase().includes(q) ||
        (t.destination.txHash?.toLowerCase().includes(q) ?? false) ||
        t.origin.sender.toLowerCase().includes(q) ||
        t.destination.recipient.toLowerCase().includes(q) ||
        t.origin.nonce === q,
    );
  }
  if (query?.originChain) {
    list = list.filter((t) => t.origin.chain === query.originChain);
  }
  if (query?.destinationChain) {
    list = list.filter((t) => t.destination.chain === query.destinationChain);
  }
  if (query?.route !== undefined) {
    list = list.filter((t) => t.route === Number(query.route));
  }

  const limit = Math.max(Number(query?.limit) || 20, 1);
  const offset = Math.max(Number(query?.offset) || 0, 0);

  return {
    transfers: list.slice(offset, offset + limit),
    limit,
    offset,
    count: list.length,
  };
}

/**
 * Look up a transfer by its origin or destination transaction hash.
 */
export async function fetchTransferByTx(txHash: string): Promise<FormattedTransfer | null> {
  const url = `${getApiBaseUrl()}/v1/transfers/by-tx/${encodeURIComponent(txHash)}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      return (await res.json()) as FormattedTransfer;
    }
  } catch {
    // Backend offline; match fixtures
  }

  const normalized = txHash.toLowerCase();
  const found = FIXTURE_TRANSFERS.find(
    (t) =>
      t.origin.txHash.toLowerCase() === normalized ||
      t.destination.txHash?.toLowerCase() === normalized,
  );
  return found ?? null;
}

/**
 * Look up a transfer by origin chain and nonce.
 */
export async function fetchTransferByNonce(
  originChain: string,
  nonce: string,
): Promise<FormattedTransfer | null> {
  const url = `${getApiBaseUrl()}/v1/transfers/${encodeURIComponent(originChain)}/${encodeURIComponent(nonce)}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      return (await res.json()) as FormattedTransfer;
    }
  } catch {
    // Backend offline; match fixtures
  }

  const found = FIXTURE_TRANSFERS.find(
    (t) => t.origin.chain === originChain && t.origin.nonce === nonce,
  );
  return found ?? null;
}

/**
 * Query parked claims with optional filters.
 */
export async function fetchClaims(query?: ClaimsQuery): Promise<ClaimsResponse> {
  const params = new URLSearchParams();
  if (query?.chain) params.set("chain", query.chain);
  if (query?.recipient) params.set("recipient", query.recipient);
  if (query?.settled !== undefined) params.set("settled", query.settled);
  if (query?.limit) params.set("limit", query.limit);
  if (query?.offset) params.set("offset", query.offset);

  const qs = params.toString();
  const url = `${getApiBaseUrl()}/v1/claims${qs ? `?${qs}` : ""}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) {
      return (await res.json()) as ClaimsResponse;
    }
  } catch {
    // Backend offline; filter fixtures
  }

  let list = [...FIXTURE_CLAIMS];
  if (query?.chain) {
    list = list.filter((c) => c.chain === query.chain);
  }
  if (query?.recipient) {
    const r = query.recipient.toLowerCase();
    list = list.filter((c) => c.recipient.toLowerCase() === r);
  }
  if (query?.settled !== undefined) {
    const isSettled = query.settled === "true";
    list = list.filter((c) => c.settled === isSettled);
  }

  const limit = Math.max(Number(query?.limit) || 20, 1);
  const offset = Math.max(Number(query?.offset) || 0, 0);

  return {
    claims: list.slice(offset, offset + limit),
    limit,
    offset,
    count: list.length,
  };
}
