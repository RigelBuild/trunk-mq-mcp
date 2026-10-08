import type { KeyObject } from "node:crypto";
import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import { GitHubHttpError } from "./github.ts";

const InstallationTokenResponse = z.object({
	token: z.string().min(1),
	expires_at: z.iso.datetime(),
});

function base64Url(value: string): string {
	return Buffer.from(value).toString("base64url");
}

export class GitHubAppTokenSource {
	readonly #appId: string;
	readonly #installationId: string;
	readonly #repositories: string[];
	readonly #privateKey: KeyObject;
	readonly #baseUrl: string;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#cachedToken: string | undefined;
	#refreshAt = 0;
	#inFlight: Promise<string> | undefined;

	constructor(opts: {
		appId: string;
		installationId: string;
		repositories: string[];
		privateKeyPem: string;
		baseUrl?: string;
		fetch?: typeof fetch;
		now?: () => number;
	}) {
		if (opts.repositories.length === 0)
			throw new Error("At least one GitHub repository is required");
		this.#appId = opts.appId;
		this.#installationId = opts.installationId;
		this.#repositories = [...opts.repositories];
		this.#privateKey = createPrivateKey(opts.privateKeyPem);
		this.#baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(
			/\/$/,
			"",
		);
		this.#fetch = opts.fetch ?? fetch;
		this.#now = opts.now ?? Date.now;
	}

	async getToken(): Promise<string> {
		if (this.#cachedToken && this.#now() < this.#refreshAt)
			return this.#cachedToken;
		if (this.#inFlight) return this.#inFlight;

		const mint = this.#mintToken();
		this.#inFlight = mint;
		try {
			return await mint;
		} finally {
			if (this.#inFlight === mint) this.#inFlight = undefined;
		}
	}

	async #mintToken(): Promise<string> {
		const issuedAt = Math.floor(this.#now() / 1000);
		const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
		const payload = base64Url(
			JSON.stringify({
				iat: issuedAt - 60,
				exp: issuedAt + 540,
				iss: this.#appId,
			}),
		);
		const unsignedToken = `${header}.${payload}`;
		const signature = sign(
			"RSA-SHA256",
			Buffer.from(unsignedToken),
			this.#privateKey,
		).toString("base64url");
		const jwt = `${unsignedToken}.${signature}`;
		const response = await this.#fetch(
			`${this.#baseUrl}/app/installations/${this.#installationId}/access_tokens`,
			{
				method: "POST",
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${jwt}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					repositories: this.#repositories,
					permissions: { pull_requests: "read" },
				}),
			},
		);
		const body = await response.text();
		if (response.status !== 201)
			throw new GitHubHttpError(response.status, body);

		let payloadValue: unknown;
		try {
			payloadValue = JSON.parse(body);
		} catch {
			throw new GitHubHttpError(response.status, body);
		}
		const tokenResponse = InstallationTokenResponse.safeParse(payloadValue);
		if (!tokenResponse.success)
			throw new GitHubHttpError(response.status, body);

		this.#cachedToken = tokenResponse.data.token;
		this.#refreshAt = Date.parse(tokenResponse.data.expires_at) - 5 * 60 * 1000;
		return tokenResponse.data.token;
	}
}
