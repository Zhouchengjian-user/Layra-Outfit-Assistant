import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthConfigurationError,
  SESSION_COOKIE_NAME,
  authenticateInvite,
  createSessionToken,
  getSessionFromRequest,
  verifySessionToken,
} from "../app/lib/auth.ts";

const managedKeys = ["NODE_ENV", "ENV", "INVITE_CODES", "SESSION_SECRET", "OWNER_ID_SECRET"];

function withAuthEnv(values, operation) {
  const previous = Object.fromEntries(managedKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return operation();
  } finally {
    for (const key of managedKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("invite login creates a signed, expiring session for a stable owner", () => {
  withAuthEnv({
    NODE_ENV: "production",
    ENV: "prod",
    INVITE_CODES: "invite-7Kp2Qm9Xv4Ls",
    SESSION_SECRET: "session-secret-for-tests-only-1234567890",
    OWNER_ID_SECRET: "owner-secret-for-tests-only-0987654321",
  }, () => {
    const userId = authenticateInvite("invite-7Kp2Qm9Xv4Ls");
    assert.match(userId || "", /^usr-[a-f0-9]{40}$/);
    assert.equal(authenticateInvite("wrong-invite-value"), null);

    const now = Date.now();
    const token = createSessionToken(userId, now);
    assert.equal(verifySessionToken(token, now + 1_000)?.userId, userId);
    assert.equal(verifySessionToken(`${token}tampered`, now + 1_000), null);
    assert.equal(verifySessionToken(token, now + 8 * 24 * 60 * 60 * 1_000), null);

    const request = new Request("https://example.test/api/profile", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    assert.equal(getSessionFromRequest(request)?.userId, userId);
  });
});

test("production auth fails closed for placeholder or weak configuration", () => {
  withAuthEnv({
    NODE_ENV: "production",
    ENV: "prod",
    INVITE_CODES: "replace_with_invite_code",
    SESSION_SECRET: "replace_with_session_secret_123456",
    OWNER_ID_SECRET: "replace_with_owner_secret_12345678",
  }, () => {
    assert.throws(() => authenticateInvite("replace_with_invite_code"), AuthConfigurationError);
  });
});
