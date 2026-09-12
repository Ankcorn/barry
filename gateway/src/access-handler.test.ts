import { describe, expect, it } from "vitest";
import { cloudflareAccessApp } from "./access-handler";

function handlerEnv(providerOverrides: Record<string, unknown> = {}) {
	return {
		OAUTH_PROVIDER: {
			parseAuthRequest: async () => {
				throw new Error(
					"Invalid client. The clientId provided does not match to this client.",
				);
			},
			lookupClient: async () => {
				throw new Error(
					"Invalid client. The clientId provided does not match to this client.",
				);
			},
			...providerOverrides,
		},
		OAUTH_KV: {},
		COOKIE_ENCRYPTION_KEY: "test-key",
		ACCESS_TOKEN_URL: "https://example.com/token",
		ACCESS_AUTHORIZATION_URL: "https://example.com/authorize",
		ACCESS_JWKS_URL: "https://example.com/jwks",
		ACCESS_CLIENT_ID: "test-client",
		ACCESS_CLIENT_SECRET: "test-secret",
	};
}

describe("GET /authorize", () => {
	it("returns 400 with an invalid_request body when the client_id is unknown", async () => {
		const env = handlerEnv();
		const req = new Request(
			"https://barry.ankcorn.dev/authorize?client_id=x&response_type=code",
		);
		const res = await cloudflareAccessApp.request(req, {}, env);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid_request");
	});

	it("returns 400 when the redirect_uri is malformed", async () => {
		const env = handlerEnv({
			parseAuthRequest: async () => {
				throw new Error("Invalid redirect URI");
			},
		});
		const req = new Request(
			"https://barry.ankcorn.dev/authorize?client_id=x&response_type=code&redirect_uri=javascript:alert(1)",
		);
		const res = await cloudflareAccessApp.request(req, {}, env);
		expect(res.status).toBe(400);
	});

	it("returns 500 when the provider fails for an internal reason", async () => {
		const env = handlerEnv({
			parseAuthRequest: async () => {
				throw new Error("OAUTH_KV read failed");
			},
		});
		const req = new Request(
			"https://barry.ankcorn.dev/authorize?client_id=x&response_type=code",
		);
		const res = await cloudflareAccessApp.request(req, {}, env);
		expect(res.status).toBe(500);
	});
});