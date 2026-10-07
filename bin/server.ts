import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TrunkClient } from "../src/client.ts";
import { GitHubClient } from "../src/github.ts";
import { GitHubAppTokenSource } from "../src/github-app.ts";
import { buildServer } from "../src/tools.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function requiredEnv(name: string, env: Environment = process.env): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

type GitHubTokenAuth = { mode: "token"; token: string };
type GitHubAppAuth = {
	mode: "app";
	appId: string;
	installationId: string;
	privateKeyFile: string;
};
export type GitHubAuthConfig = GitHubTokenAuth | GitHubAppAuth;

export function githubAuthConfigFromEnv(
	env: Environment = process.env,
): GitHubAuthConfig {
	const tokenName = "TRUNK_MQ_GITHUB_TOKEN";
	const appNames = [
		"TRUNK_MQ_GITHUB_APP_ID",
		"TRUNK_MQ_GITHUB_INSTALLATION_ID",
		"TRUNK_MQ_GITHUB_APP_KEY_FILE",
	] as const;
	const hasToken = env[tokenName] !== undefined;
	const appValues = appNames.map((name) => env[name]);
	const hasAnyAppValue = appValues.some((value) => value !== undefined);
	const hasFullAppConfig = appValues.every((value) => value !== undefined);

	if (hasToken && hasAnyAppValue)
		throw new Error(
			`Configure either ${tokenName} or all GitHub App variables, not both`,
		);
	if (hasAnyAppValue && !hasFullAppConfig)
		throw new Error(
			`All GitHub App variables are required: ${appNames.join(", ")}`,
		);
	if (!hasToken && !hasAnyAppValue)
		throw new Error(
			`Configure ${tokenName} or all GitHub App variables: ${appNames.join(", ")}`,
		);

	if (hasToken) return { mode: "token", token: requiredEnv(tokenName, env) };
	return {
		mode: "app",
		appId: requiredEnv(appNames[0], env),
		installationId: requiredEnv(appNames[1], env),
		privateKeyFile: requiredEnv(appNames[2], env),
	};
}

function numberEnv(name: string, fallback: number): number {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0)
		throw new Error(`${name} must be a positive integer`);
	return parsed;
}

export const MAX_BODY_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function configuredHost(): string {
	const host = process.env.TRUNK_MQ_HOST ?? "127.0.0.1";
	if (!LOOPBACK_HOSTS.has(host))
		throw new Error(
			"TRUNK_MQ_HOST must be a loopback host (127.0.0.1, localhost, or ::1)",
		);
	return host;
}

type BodyResult =
	| { kind: "ok"; value: string }
	| { kind: "too-large" }
	| { kind: "timeout" }
	| { kind: "error"; error: unknown };

export function readRequestBody(req: IncomingMessage): Promise<BodyResult> {
	const { promise, resolve } = Promise.withResolvers<BodyResult>();
	let value = "";
	let bytes = 0;
	let settled = false;
	const timeout = setTimeout(() => {
		if (settled) return;
		settled = true;
		req.resume();
		resolve({ kind: "timeout" });
	}, REQUEST_TIMEOUT_MS);
	const finish = (result: BodyResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		resolve(result);
	};

	req.setEncoding("utf8");
	req.on("data", (chunk: string) => {
		if (settled) return;
		bytes += Buffer.byteLength(chunk, "utf8");
		if (bytes > MAX_BODY_BYTES) {
			finish({ kind: "too-large" });
			req.resume();
			return;
		}
		value += chunk;
	});
	req.on("end", () => finish({ kind: "ok", value }));
	req.on("error", (error: unknown) => finish({ kind: "error", error }));
	return promise;
}

export function createHttpHandler(deps: Parameters<typeof buildServer>[0]) {
	return async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const port = numberEnv("TRUNK_MQ_PORT", 4005);
			if (
				!isAllowedHost(req.headers.host, port) ||
				!isAllowedOrigin(req.headers.origin, port)
			) {
				res.statusCode = 403;
				res.end("Forbidden");
				return;
			}
			if (req.url !== "/mcp") {
				res.statusCode = 404;
				res.end("Not found");
				return;
			}
			if (req.method !== "POST") {
				res.statusCode = 405;
				res.setHeader("Allow", "POST");
				res.end("Method not allowed");
				return;
			}
			const body = await readRequestBody(req);
			if (body.kind === "too-large") {
				res.statusCode = 413;
				res.end("Request body too large");
				return;
			}
			if (body.kind === "timeout") {
				res.statusCode = 408;
				res.end("Request timeout");
				return;
			}
			if (body.kind === "error") throw body.error;

			let parsedBody: unknown;
			try {
				parsedBody = JSON.parse(body.value);
			} catch {
				res.statusCode = 400;
				res.end("Invalid JSON");
				return;
			}
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
			});
			const server = buildServer(deps);
			await server.connect(transport);
			await transport.handleRequest(req, res, parsedBody);
		} catch {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			res.statusCode = 500;
			res.end("Internal server error");
		}
	};
}

function isAllowedHost(
	value: string | string[] | undefined,
	port: number,
): boolean {
	if (value === undefined) return true;
	if (Array.isArray(value)) return false;
	try {
		const url = new URL(`http://${value}`);
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		return (
			LOOPBACK_HOSTS.has(hostname) &&
			(url.port === "" || Number(url.port) === port)
		);
	} catch {
		return false;
	}
}
function isAllowedOrigin(
	value: string | string[] | undefined,
	port: number,
): boolean {
	if (value === undefined) return true;
	if (Array.isArray(value)) return false;
	try {
		const url = new URL(value);
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		return (
			url.protocol === "http:" &&
			LOOPBACK_HOSTS.has(hostname) &&
			(url.port === "" || Number(url.port) === port)
		);
	} catch {
		return false;
	}
}

export function startServer() {
	const githubAuth = githubAuthConfigFromEnv();
	const trunk = new TrunkClient({ token: requiredEnv("TRUNK_MQ_TRUNK_TOKEN") });
	let githubToken: string | (() => Promise<string>);
	if (githubAuth.mode === "token") {
		githubToken = githubAuth.token;
	} else {
		const tokenSource = new GitHubAppTokenSource({
			appId: githubAuth.appId,
			installationId: githubAuth.installationId,
			privateKeyPem: readFileSync(githubAuth.privateKeyFile, "utf8"),
		});
		githubToken = tokenSource.getToken.bind(tokenSource);
	}
	const github = new GitHubClient({ token: githubToken });
	const host = configuredHost();
	const port = numberEnv("TRUNK_MQ_PORT", 4005);
	const server = createServer(createHttpHandler({ trunk, github }));
	server.listen(port, host);
	return server;
}

if (import.meta.main) startServer();
