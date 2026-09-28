import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  agentAuthorizeUrl,
  agentIdentityConfig,
  agentIdentityDiscovery,
  exchangeAgentCode,
  newAgentTransaction,
  readAgentTransaction,
  sealAgentTransaction,
} from "../app/lib/agent-identity.ts";

const keys = ["NODE_ENV", "AGENT_IDENTITY_ISSUER", "AGENT_IDENTITY_CLIENT_ID", "AGENT_IDENTITY_CLIENT_SECRET", "AGENT_IDENTITY_REDIRECT_URI", "SESSION_SECRET"];

async function withEnvironment(values, operation) {
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await operation(); }
  finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

test("OIDC transaction is signed, state-bound and short lived", async () => {
  await withEnvironment({ SESSION_SECRET: "session-secret-for-tests-only-1234567890" }, () => {
    const now = Date.now();
    const transaction = newAgentTransaction(now);
    const cookie = sealAgentTransaction(transaction);
    assert.deepEqual(readAgentTransaction(cookie, transaction.state, now), transaction);
    assert.equal(readAgentTransaction(cookie, "wrong-state", now), null);
    assert.equal(readAgentTransaction(`${cookie}tampered`, transaction.state, now), null);
    assert.equal(readAgentTransaction(cookie, transaction.state, now + 11 * 60_000), null);
  });
});

test("OIDC code flow validates issuer, audience, nonce and signature", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  let issuer = "";
  let tokenNonce = "";
  let expectedVerifier = "";
  let expectedClientId = "web-client";
  const server = createServer(async (request, response) => {
    if (request.url === "/pool/.well-known/openid-configuration") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, id_token_signing_alg_values_supported: ["RS256"] }));
      return;
    }
    if (request.url === "/pool/jwks") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (request.url === "/pool/token") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      assert.equal(body.get("code_verifier"), expectedVerifier);
      assert.equal(request.headers.authorization, `Basic ${Buffer.from(`${expectedClientId}:server-secret`).toString("base64")}`);
      const idToken = await new SignJWT({ nonce: tokenNonce })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuer).setAudience("web-client").setSubject("user-123")
        .setIssuedAt().setExpirationTime("5m").sign(privateKey);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id_token: idToken }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  issuer = `http://127.0.0.1:${address.port}/pool`;
  try {
    await withEnvironment({ NODE_ENV: "test", AGENT_IDENTITY_ISSUER: issuer, AGENT_IDENTITY_CLIENT_ID: "web-client", AGENT_IDENTITY_CLIENT_SECRET: "server-secret", AGENT_IDENTITY_REDIRECT_URI: "http://localhost:3000/api/auth/agent/callback", SESSION_SECRET: "session-secret-for-tests-only-1234567890" }, async () => {
      const config = agentIdentityConfig();
      const discovery = await agentIdentityDiscovery(config);
      const transaction = newAgentTransaction();
      expectedVerifier = transaction.verifier;
      tokenNonce = transaction.nonce;
      const authorize = agentAuthorizeUrl(config, discovery, transaction);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorize.searchParams.get("state"), transaction.state);
      assert.equal(await exchangeAgentCode(config, discovery, "sample-code", transaction), "user-123");
      tokenNonce = "wrong-nonce";
      await assert.rejects(exchangeAgentCode(config, discovery, "sample-code", transaction), /登录状态不匹配/);
      tokenNonce = transaction.nonce;
      expectedClientId = "other-client";
      await assert.rejects(exchangeAgentCode({ ...config, clientId: "other-client" }, discovery, "sample-code", transaction));
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
