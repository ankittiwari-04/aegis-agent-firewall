import { expect } from "chai";
import { DEFAULT_PROGRAM_ID, health, loadConfig } from "../src";

describe("gateway config (localnet and devnet only)", () => {
  it("loads safe defaults: localnet and the Aegis program id", () => {
    const c = loadConfig({});
    expect(c.cluster).to.equal("localnet");
    expect(c.rpcUrl).to.equal("http://127.0.0.1:8899");
    expect(c.programId.toBase58()).to.equal(DEFAULT_PROGRAM_ID);
  });

  it("accepts an explicit localhost RPC URL", () => {
    const c = loadConfig({ AEGIS_RPC_URL: "http://localhost:8899" });
    expect(c.cluster).to.equal("localnet");
  });

  it("accepts the public devnet RPC over https", () => {
    const c = loadConfig({ AEGIS_RPC_URL: "https://api.devnet.solana.com" });
    expect(c.cluster).to.equal("devnet");
  });

  it("rejects mainnet and any other host", () => {
    for (const url of ["https://api.mainnet-beta.solana.com", "https://example.com"]) {
      expect(() => loadConfig({ AEGIS_RPC_URL: url })).to.throw(/localnet or devnet only/);
    }
  });

  it("rejects look-alike hostnames", () => {
    expect(() => loadConfig({ AEGIS_RPC_URL: "http://127.0.0.1.evil.com:8899" })).to.throw(
      /localnet or devnet only/
    );
    expect(() => loadConfig({ AEGIS_RPC_URL: "https://api.devnet.solana.com.evil.com" })).to.throw(
      /localnet or devnet only/
    );
  });

  it("rejects credentials embedded in the RPC URL", () => {
    expect(() => loadConfig({ AEGIS_RPC_URL: "http://user:pass@127.0.0.1:8899" })).to.throw(/credentials/);
    expect(() => loadConfig({ AEGIS_RPC_URL: "http://localhost@evil.com" })).to.throw(/credentials/);
  });

  it("rejects non-http protocols and malformed URLs", () => {
    expect(() => loadConfig({ AEGIS_RPC_URL: "file:///etc/passwd" })).to.throw(/http or https/);
    expect(() => loadConfig({ AEGIS_RPC_URL: "not a url" })).to.throw(/not a valid URL/);
  });

  it("rejects devnet over plain http", () => {
    expect(() => loadConfig({ AEGIS_RPC_URL: "http://api.devnet.solana.com" })).to.throw(/must use https/);
  });

  it("rejects an invalid or empty program id instead of falling back to the default", () => {
    expect(() => loadConfig({ AEGIS_PROGRAM_ID: "not-a-key" })).to.throw(/not a valid public key/);
    expect(() => loadConfig({ AEGIS_PROGRAM_ID: "" })).to.throw(/not a valid public key/);
  });
});

describe("health check", () => {
  it("reports ok with a valid configuration and does not leak the RPC URL", () => {
    expect(health({})).to.deep.equal({
      status: "ok",
      service: "aegis-gateway",
      cluster: "localnet",
      programId: DEFAULT_PROGRAM_ID,
    });
  });

  it("throws when the configuration is invalid", () => {
    expect(() => health({ AEGIS_RPC_URL: "https://api.mainnet-beta.solana.com" })).to.throw(
      /localnet or devnet only/
    );
  });
});
