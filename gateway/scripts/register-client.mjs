#!/usr/bin/env node
/**
 * Pre-register an OAuth client in the KV store.
 *
 * Usage:
 *   node scripts/register-client.mjs --name "Claude" --redirect-uri "https://claude.ai/..."
 *
 * The script prints the client_id and client_secret to stdout, then writes
 * the hashed client record to KV via wrangler.
 *
 * Options:
 *   --name         Human-readable client name (required)
 *   --redirect-uri Allowed redirect URI (required, repeat for multiple)
 *   --client-id    Use a specific client_id instead of generating one
 *   --dry-run      Print the KV record without writing it
 */

import { execSync } from "child_process";
import { randomBytes, createHash } from "crypto";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

function getAllArgs(flag) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]);
  }
  return values;
}

const name = getArg("--name");
const redirectUris = getAllArgs("--redirect-uri");
const clientIdArg = getArg("--client-id");
const dryRun = args.includes("--dry-run");

if (!name || redirectUris.length === 0) {
  console.error("Usage: node scripts/register-client.mjs --name <name> --redirect-uri <uri> [--redirect-uri <uri2>] [--client-id <id>] [--dry-run]");
  process.exit(1);
}

const clientId = clientIdArg ?? randomBytes(12).toString("base64url");
const clientSecret = randomBytes(24).toString("base64url");
const hashedSecret = createHash("sha256").update(clientSecret).digest("hex");

const client = {
  clientId,
  clientSecret: hashedSecret,
  clientName: name,
  redirectUris,
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "client_secret_post",
  registrationDate: Math.floor(Date.now() / 1000),
};

console.log("\n=== Client Credentials (save these now, secret is not recoverable) ===");
console.log(`client_id:     ${clientId}`);
console.log(`client_secret: ${clientSecret}`);
console.log(`redirect_uris: ${redirectUris.join(", ")}`);
console.log("=====================================================================\n");

if (dryRun) {
  console.log("Dry run — KV record would be:");
  console.log(JSON.stringify(client, null, 2));
  process.exit(0);
}

const NAMESPACE_ID = "e82f369881894800b1b6ba632b5bca43";
const key = `client:${clientId}`;
const value = JSON.stringify(client);

const tmpFile = join(tmpdir(), `mcp-client-${clientId}.json`);
writeFileSync(tmpFile, value);

console.log(`Writing to KV: ${key}`);
try {
  execSync(
    `npx wrangler kv key put "${key}" --namespace-id ${NAMESPACE_ID} --remote --path "${tmpFile}"`,
    { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname }
  );
} finally {
  unlinkSync(tmpFile);
}

console.log("\nClient registered successfully.");
