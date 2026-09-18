import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TrunkClient } from "../src/client.ts";
import { GitHubClient } from "../src/github.ts";
import { buildServer } from "../src/tools.ts";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
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
		if (req.url !== "/mcp" || req.method !== "POST") {
			res.statusCode = 404;
			res.end("Not found");
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
	};
}

export function startServer() {
	const trunk = new TrunkClient({ token: requiredEnv("TRUNK_MQ_TRUNK_TOKEN") });
	const github = new GitHubClient({
		token: requiredEnv("TRUNK_MQ_GITHUB_TOKEN"),
	});
	const host = configuredHost();
	const port = numberEnv("TRUNK_MQ_PORT", 4005);
	const server = createServer(createHttpHandler({ trunk, github }));
	server.listen(port, host);
	return server;
}

if (import.meta.main) startServer();
