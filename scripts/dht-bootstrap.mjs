/**
 * Hyperswarm DHT bootstrap node entrypoint.
 *
 * Runs a DHT node in bootstrap-only mode. Configuration via environment:
 *   DHT_PORT  — UDP port to listen on (default: 49737)
 *   DHT_PEERS — Comma-separated host:port list of other bootstrap nodes
 *
 * Persistent state is written to /data so the node's keypair survives restarts.
 */
import DHT from "@hyperswarm/dht";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const port = Number.parseInt(process.env.DHT_PORT || "49737", 10);
const peersRaw = process.env.DHT_PEERS || "";
const dataDir = "/data";
const keyPath = join(dataDir, "keypair.json");

// Parse peer addresses
const bootstrap = peersRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((addr) => {
    const [host, portStr] = addr.split(":");
    return { host, port: Number.parseInt(portStr, 10) };
  });

// Load or generate a persistent keypair
let keyPair;
if (existsSync(keyPath)) {
  const stored = JSON.parse(readFileSync(keyPath, "utf-8"));
  keyPair = DHT.keyPair(Buffer.from(stored.seed, "hex"));
  console.log(`Loaded existing keypair from ${keyPath}`);
} else {
  mkdirSync(dataDir, { recursive: true });
  const seed = DHT.hash(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
  keyPair = DHT.keyPair(seed);
  writeFileSync(keyPath, JSON.stringify({ seed: seed.toString("hex") }));
  console.log(`Generated new keypair, saved to ${keyPath}`);
}

const node = new DHT({
  port,
  keyPair,
  bootstrap: bootstrap.length > 0 ? bootstrap : undefined,
});

await node.ready();

console.log(
  `DHT bootstrap node listening on port ${port}`,
  bootstrap.length > 0 ? `(peers: ${peersRaw})` : "(standalone)",
);

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log(`Received ${signal}, shutting down DHT node...`);
    await node.destroy();
    process.exit(0);
  });
}
