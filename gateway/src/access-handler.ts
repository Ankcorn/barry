import { Buffer } from "node:buffer";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
	addApprovedClient,
	createOAuthState,
	fetchUpstreamAuthToken,
	generateCSRFProtection,
	getUpstreamAuthorizeUrl,
	isClientApproved,
	OAuthError,
	type Props,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

type Bindings = Env & {
	OAUTH_PROVIDER: OAuthHelpers;
	COOKIE_ENCRYPTION_KEY: string;
	ACCESS_TOKEN_URL: string;
	ACCESS_AUTHORIZATION_URL: string;
	ACCESS_JWKS_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) return c.text("Invalid request", 400);

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken, codeChallenge } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV, c.env.COOKIE_ENCRYPTION_KEY);
		return redirectToAccess(c.req.raw, c.env, stateToken, codeChallenge);
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();
	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			name: "Barry",
			description: "Personal MCP server running on my Raspberry Pi.",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.formData();
		const csrfResult = validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") return c.text("Missing state in form data", 400);

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo?.clientId) return c.text("Invalid request", 400);

		const approvedClientCookie = await addApprovedClient(c.req.raw, state.oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY);
		const { stateToken, codeChallenge } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV, c.env.COOKIE_ENCRYPTION_KEY);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", csrfResult.clearCookie);
		return redirectToAccess(c.req.raw, c.env, stateToken, codeChallenge, headers);
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Internal server error", 500);
	}
});

app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let codeVerifier: string;

	try {
		({ oauthReqInfo, codeVerifier } = await validateOAuthState(c.req.raw, c.env.OAUTH_KV, c.env.COOKIE_ENCRYPTION_KEY));
	} catch (error) {
		if (error instanceof OAuthError) return error.toResponse();
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) return c.text("Invalid OAuth request data", 400);

	const code = new URL(c.req.url).searchParams.get("code") ?? undefined;
	const [accessToken, idToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.ACCESS_CLIENT_ID,
		client_secret: c.env.ACCESS_CLIENT_SECRET,
		code,
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: c.env.ACCESS_TOKEN_URL,
		code_verifier: codeVerifier,
	});

	if (errResponse) return errResponse;

	const claims = await verifyToken(c.env, idToken);

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: claims.name },
		props: {
			accessToken,
			email: claims.email,
			login: claims.sub,
			name: claims.name,
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: claims.sub,
	});

	return c.redirect(redirectTo, 302);
});

export const cloudflareAccessApp = app;

// --- Helpers ---

function redirectToAccess(request: Request, env: Bindings, stateToken: string, codeChallenge: string, extraHeaders: Headers = new Headers()): Response {
	const headers = new Headers(extraHeaders);
	headers.set("Location", getUpstreamAuthorizeUrl({
		client_id: env.ACCESS_CLIENT_ID,
		code_challenge: codeChallenge,
		redirect_uri: new URL("/callback", request.url).href,
		scope: "openid email profile",
		state: stateToken,
		upstream_url: env.ACCESS_AUTHORIZATION_URL,
	}));
	return new Response(null, { status: 302, headers });
}

async function fetchAccessPublicKey(env: Bindings, kid: string): Promise<CryptoKey> {
	const resp = await fetch(env.ACCESS_JWKS_URL);
	const { keys } = (await resp.json()) as { keys: (JsonWebKey & { kid: string })[] };
	const jwk = keys.find((k) => k.kid === kid);
	if (!jwk) throw new Error(`Public key not found for kid: ${kid}`);
	return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

function parseJWT(token: string) {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Token must have 3 parts");
	return {
		data: `${parts[0]}.${parts[1]}`,
		header: JSON.parse(Buffer.from(parts[0], "base64url").toString()),
		payload: JSON.parse(Buffer.from(parts[1], "base64url").toString()),
		signature: parts[2],
	};
}

async function verifyToken(env: Bindings, token: string) {
	const jwt = parseJWT(token);
	const key = await fetchAccessPublicKey(env, jwt.header.kid);

	const verified = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		Buffer.from(jwt.signature, "base64url"),
		Buffer.from(jwt.data),
	);
	if (!verified) throw new Error("Failed to verify token");

	if (jwt.payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Expired token");

	return jwt.payload;
}
