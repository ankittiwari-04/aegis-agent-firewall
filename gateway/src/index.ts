import { loadConfig } from "./config";
import type { Cluster } from "./config";

export * from "./types";
export { DEFAULT_PROGRAM_ID, DEFAULT_RPC_URL, loadConfig } from "./config";
export type { Cluster, GatewayConfig } from "./config";
export { ACCOUNT_SIZE, MAX_ALLOWED_RECIPIENTS, MandateLoadError, getMandateStatus, loadMandate } from "./mandate";
export type { AccountFetcher, LoadMandateOptions, MandateErrorCode, MandateStatus, RawAccount } from "./mandate";
export { evaluateTransaction } from "./policy";
export type { EvaluateOptions } from "./policy";
export { readChainTime } from "./clock";
export {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  MAX_TRANSACTION_BYTES,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransaction,
} from "./transaction";

export interface HealthStatus {
  status: "ok";
  service: "aegis-gateway";
  cluster: Cluster;
  programId: string;
}

/** Throws if the configuration is invalid: a misconfigured gateway is not healthy. */
export function health(env: Record<string, string | undefined> = process.env): HealthStatus {
  const config = loadConfig(env);
  return {
    status: "ok",
    service: "aegis-gateway",
    cluster: config.cluster,
    programId: config.programId.toBase58(),
  };
}

export { evaluateWithReceipt } from "./policy";
export type { EvaluationOutcome } from "./policy";
export { DEFAULT_MAX_FEE_LAMPORTS, connectionSimulationBackend, runSimulation } from "./simulation";
export type {
  AccountSnapshot,
  RawSimulatedAccount,
  RawSimulation,
  RunSimulationArgs,
  SimulationBackend,
} from "./simulation";
export {
  JsonlReceiptStore,
  MemoryReceiptStore,
  POLICY_VERSION,
  buildReceipt,
  canonicalJson,
  hashSummary,
} from "./receipt";
export type { DecisionReceipt, ReceiptStore } from "./receipt";
