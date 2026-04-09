import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import * as oauth from "oauth4webapi";

export class OAuthError extends Error {
	constructor(
		public code: string,
		public description: string,
		public statusCode = 400,
	) {
		super(description);
		this.name = "OAuthError";
	}

	toResponse(): Response {
		return new Response(
			JSON.stringify({ error: this.code, error_description: this.description }),
			{ status: this.statusCode, headers: { "Content-Type": "application/json" } },
		);
	}
}

export interface OAuthStateResult {
	state: string;
	codeChallenge: string;
}

export interface ValidateStateResult {
	oauthReqInfo: AuthRequest;
	codeVerifier: string;
}

export async function createOAuthState(
	oauthReqInfo: AuthRequest,
	kv: KVNamespace,
	stateTTL = 600,
): Promise<OAuthStateResult> {
	const state = oauth.generateRandomState();
	const codeVerifier = oauth.generateRandomCodeVerifier();
	const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

	await kv.put(`oauth:state:${state}`, JSON.stringify({ oauthReqInfo, codeVerifier }), {
		expirationTtl: stateTTL,
	});

	return { state, codeChallenge };
}

export async function lookupOAuthState(
	state: string,
	kv: KVNamespace,
): Promise<ValidateStateResult> {
	const storedDataJson = await kv.get(`oauth:state:${state}`);
	if (!storedDataJson) {
		throw new OAuthError("invalid_request", "Invalid or expired state", 400);
	}

	let stored: { oauthReqInfo: AuthRequest; codeVerifier: string };
	try {
		stored = JSON.parse(storedDataJson);
	} catch (_e) {
		throw new OAuthError("server_error", "Invalid state data", 500);
	}

	await kv.delete(`oauth:state:${state}`);

	return { oauthReqInfo: stored.oauthReqInfo, codeVerifier: stored.codeVerifier };
}

export interface Props {
	accessToken: string;
	email: string;
	login: string;
	name: string;
	[key: string]: unknown;
}
