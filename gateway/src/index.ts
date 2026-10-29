import { loadConfig } from "./config";
import type { Cluster } from "./config";

export * from "./types";
export { DEFAULT_PROGRAM_ID, DEFAULT_RPC_URL, loadConfig } from "./config";
export type { Cluster, GatewayConfig } from "./config";
export { evaluateTransaction } from "./policy";

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
