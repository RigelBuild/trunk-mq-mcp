import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { githubAuthConfigFromEnv } from "../bin/server.ts";
import { GitHubClient, GitHubHttpError } from "../src/github.ts";
import { GitHubAppTokenSource } from "../src/github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

function mockFetch(
	handler: (
		url: string | Request | URL,
		init?: RequestInit,
	) => Promise<Response>,
): typeof fetch {
	return Object.assign(handler, { preconnect: fetch.preconnect });
}

function decodeJwtPart(value: string): unknown {
	return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

const tokenResponse = (token: string, expiresAt: string) =>
	new Response(JSON.stringify({ token, expires_at: expiresAt }), {
		status: 201,
	});

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("mints narrowed installation token with verifiable RS256 JWT", async () => {
	const now = Date.UTC(2026, 0, 2, 3, 4, 5);
	let request: { url: string; init?: RequestInit } | undefined;
	const source = new GitHubAppTokenSource({
		appId: "app-123",
		installationId: "install-456",
		privateKeyPem: privateKey,
		baseUrl: "https://api.example.test/",
		now: () => now,
		fetch: mockFetch(async (url, init) => {
			request = { url: String(url), init };
			return tokenResponse(
				"installation-token",
				new Date(now + 60 * 60_000).toISOString(),
			);
		}),
	});

	expect(await source.getToken()).toBe("installation-token");
	expect(request?.url).toBe(
		"https://api.example.test/app/installations/install-456/access_tokens",
	);
	expect(request?.init?.method).toBe("POST");
	expect(new Headers(request?.init?.headers).get("accept")).toBe(
		"application/vnd.github+json",
	);
	expect(JSON.parse(String(request?.init?.body))).toEqual({
		permissions: { pull_requests: "read" },
	});

	const authorization = new Headers(request?.init?.headers).get(
		"authorization",
	);
	expect(authorization).not.toBeNull();
	const jwtParts = (authorization ?? "").replace("Bearer ", "").split(".");
	expect(jwtParts).toHaveLength(3);
	const [encodedHeader, encodedPayload, encodedSignature] = jwtParts;
	if (!encodedHeader || !encodedPayload || !encodedSignature)
		throw new Error("Expected a three-part JWT");
	expect(decodeJwtPart(encodedHeader)).toEqual({ alg: "RS256", typ: "JWT" });
	expect(decodeJwtPart(encodedPayload)).toEqual({
		iat: Math.floor(now / 1000) - 60,
		exp: Math.floor(now / 1000) + 540,
		iss: "app-123",
	});
	expect(
		verify(
			"RSA-SHA256",
			Buffer.from(`${encodedHeader}.${encodedPayload}`),
			publicKey,
			Buffer.from(encodedSignature, "base64url"),
		),
	).toBe(true);
});

test("caches until five minutes before expiry, then refreshes", async () => {
	let now = Date.UTC(2026, 0, 2, 3, 4, 5);
	let mintCount = 0;
	const source = new GitHubAppTokenSource({
		appId: "app-123",
		installationId: "install-456",
		privateKeyPem: privateKey,
		now: () => now,
		fetch: mockFetch(async () => {
			mintCount += 1;
			return tokenResponse(
				`token-${mintCount}`,
				new Date(now + 60 * 60_000).toISOString(),
			);
		}),
	});

	expect(await source.getToken()).toBe("token-1");
	now += 54 * 60_000 + 1_000;
	expect(await source.getToken()).toBe("token-1");
	now += 60_000;
	expect(await source.getToken()).toBe("token-2");
	expect(mintCount).toBe(2);
});

test("concurrent token callers share a mint", async () => {
	let mintCount = 0;
	let releaseMint: ((response: Response) => void) | undefined;
	const source = new GitHubAppTokenSource({
		appId: "app-123",
		installationId: "install-456",
		privateKeyPem: privateKey,
		now: () => Date.UTC(2026, 0, 2),
		fetch: mockFetch(async () => {
			mintCount += 1;
			return await new Promise<Response>((resolve) => {
				releaseMint = resolve;
			});
		}),
	});

	const first = source.getToken();
	const second = source.getToken();
	expect(mintCount).toBe(1);
	releaseMint?.(
		tokenResponse(
			"shared-token",
			new Date(Date.UTC(2026, 0, 2, 1)).toISOString(),
		),
	);
	expect(await Promise.all([first, second])).toEqual([
		"shared-token",
		"shared-token",
	]);
});

test("non-201 installation responses throw GitHubHttpError", async () => {
	const source = new GitHubAppTokenSource({
		appId: "app-123",
		installationId: "install-456",
		privateKeyPem: privateKey,
		fetch: mockFetch(async () => new Response("denied", { status: 403 })),
	});

	await expect(source.getToken()).rejects.toBeInstanceOf(GitHubHttpError);
	await expect(source.getToken()).rejects.toMatchObject({
		status: 403,
		body: "denied",
	});
});
test("rejects malformed successful installation response", async () => {
	const source = new GitHubAppTokenSource({
		appId: "app-123",
		installationId: "install-456",
		privateKeyPem: privateKey,
		fetch: mockFetch(
			async () =>
				new Response(JSON.stringify({ token: "bad" }), { status: 201 }),
		),
	});

	await expect(source.getToken()).rejects.toBeInstanceOf(GitHubHttpError);
});
test("retries token mint after failure and caches the recovered token", async () => {
	let fetchCount = 0;
	const now = Date.UTC(2026, 0, 2, 3, 4, 5);
	const source = new GitHubAppTokenSource({
		appId: "app-123",
		installationId: "install-456",
		privateKeyPem: privateKey,
		now: () => now,
		fetch: mockFetch(async () => {
			fetchCount += 1;
			if (fetchCount === 1) return new Response("unavailable", { status: 500 });
			return tokenResponse(
				"recovered-token",
				new Date(now + 60 * 60_000).toISOString(),
			);
		}),
	});

	await expect(source.getToken()).rejects.toMatchObject({ status: 500 });
	expect(fetchCount).toBe(1);
	expect(await source.getToken()).toBe("recovered-token");
	expect(fetchCount).toBe(2);
	expect(await source.getToken()).toBe("recovered-token");
	expect(fetchCount).toBe(2);
});

test("GitHub client resolves token source before search request", async () => {
	globalThis.fetch = mockFetch(async (_url, init) => {
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer minted-search-token",
		);
		return Response.json({ items: [] });
	});
	const client = new GitHubClient({ token: async () => "minted-search-token" });

	await client.searchTrialPullRequests(
		{ owner: "RigelBuild", repo: "orion" },
		42,
	);
});

test("GitHub auth config requires exactly one complete mode", () => {
	const app = {
		TRUNK_MQ_GITHUB_APP_ID: "app-id",
		TRUNK_MQ_GITHUB_INSTALLATION_ID: "installation-id",
		TRUNK_MQ_GITHUB_APP_KEY_FILE: "/secrets/app.pem",
	};
	expect(() => githubAuthConfigFromEnv({})).toThrow(/Configure/);
	expect(() =>
		githubAuthConfigFromEnv({ TRUNK_MQ_GITHUB_TOKEN: "token", ...app }),
	).toThrow(/not both/);
	for (const partial of [
		{ TRUNK_MQ_GITHUB_APP_ID: "app-id" },
		{ TRUNK_MQ_GITHUB_INSTALLATION_ID: "installation-id" },
		{ TRUNK_MQ_GITHUB_APP_KEY_FILE: "/secrets/app.pem" },
	]) {
		expect(() => githubAuthConfigFromEnv(partial)).toThrow(
			/All GitHub App variables/,
		);
	}
	expect(githubAuthConfigFromEnv({ TRUNK_MQ_GITHUB_TOKEN: "token" })).toEqual({
		mode: "token",
		token: "token",
	});
	expect(githubAuthConfigFromEnv(app)).toEqual({
		mode: "app",
		appId: "app-id",
		installationId: "installation-id",
		privateKeyFile: "/secrets/app.pem",
	});
	expect(
		githubAuthConfigFromEnv({ ...app, TRUNK_MQ_GITHUB_TOKEN: "" }),
	).toEqual({
		mode: "app",
		appId: "app-id",
		installationId: "installation-id",
		privateKeyFile: "/secrets/app.pem",
	});
	expect(
		githubAuthConfigFromEnv({
			TRUNK_MQ_GITHUB_TOKEN: "token",
			TRUNK_MQ_GITHUB_APP_ID: "",
			TRUNK_MQ_GITHUB_INSTALLATION_ID: "",
			TRUNK_MQ_GITHUB_APP_KEY_FILE: "",
		}),
	).toEqual({ mode: "token", token: "token" });
	expect(() =>
		githubAuthConfigFromEnv({
			TRUNK_MQ_GITHUB_APP_ID: "app-id",
			TRUNK_MQ_GITHUB_INSTALLATION_ID: "installation-id",
			TRUNK_MQ_GITHUB_APP_KEY_FILE: "",
		}),
	).toThrow(/All GitHub App variables/);
});
