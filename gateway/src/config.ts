import { PublicKey } from "@solana/web3.js";

export const DEFAULT_RPC_URL = "http://127.0.0.1:8899";
export const DEFAULT_PROGRAM_ID = "5RiVTk3kzfvz1pn9NiMDjaR1x6Vom565W9pFzNwVK5Bp";

export type Cluster = "localnet" | "devnet";

export interface GatewayConfig {
  rpcUrl: string;
  cluster: Cluster;
  programId: PublicKey;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const DEVNET_HOST = "api.devnet.solana.com";

/**
 * Loads and validates configuration. Localnet and devnet only: anything else is rejected
 * (fail closed). Error messages never echo the full URL because it could contain credentials.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const rawUrl = env.AEGIS_RPC_URL ?? DEFAULT_RPC_URL;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("AEGIS_RPC_URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AEGIS_RPC_URL must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("AEGIS_RPC_URL must not contain credentials");
  }

  let cluster: Cluster;
  if (LOCAL_HOSTS.has(url.hostname)) {
    cluster = "localnet";
  } else if (url.hostname === DEVNET_HOST) {
    if (url.protocol !== "https:") {
      throw new Error("Devnet RPC must use https");
    }
    cluster = "devnet";
  } else {
    throw new Error(`RPC host not allowed (localnet or devnet only): ${url.hostname}`);
  }

  let programId: PublicKey;
  try {
    programId = new PublicKey(env.AEGIS_PROGRAM_ID ?? DEFAULT_PROGRAM_ID);
  } catch {
    throw new Error("AEGIS_PROGRAM_ID is not a valid public key");
  }

  // Only the origin is used, so the host that was validated is exactly the host that is called.
  return { rpcUrl: url.origin, cluster, programId };
}
