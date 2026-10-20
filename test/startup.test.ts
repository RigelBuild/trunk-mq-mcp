import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer } from "../bin/server.ts";

const SERVICE_HOST = "trunk-mq-mcp.llm-gateway.svc.cluster.local";
const ENV_KEYS = [
	"TRUNK_MQ_HOST",
	"TRUNK_MQ_PORT",
	"TRUNK_MQ_ALLOWED_HOSTS",
	"TRUNK_MQ_TRUNK_TOKEN",
	"TRUNK_MQ_GITHUB_TOKEN",
] as const;

let server: Server | undefined;

afterEach(async () => {
	if (server) await new Promise((resolve) => server?.close(resolve));
	server = undefined;
	for (const key of ENV_KEYS) delete process.env[key];
});

async function freePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise((resolve) => probe.close(resolve));
	return port;
}

async function post(port: number, host: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/mcp`, {
		method: "POST",
		headers: {
			host,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
}

test("serves a Service Host request after binding all interfaces", async () => {
	const port = await freePort();
	Object.assign(process.env, {
		TRUNK_MQ_HOST: "0.0.0.0",
		TRUNK_MQ_PORT: String(port),
		TRUNK_MQ_ALLOWED_HOSTS: SERVICE_HOST,
		TRUNK_MQ_TRUNK_TOKEN: "test-trunk-token",
		TRUNK_MQ_GITHUB_TOKEN: "test-github-token",
	});
	server = startServer();
	await new Promise((resolve) => server?.once("listening", resolve));
	expect((server.address() as AddressInfo).address).toBe("0.0.0.0");

	const ok = await post(port, `${SERVICE_HOST}:${port}`);
	expect(ok.status).toBe(200);
	expect(await ok.text()).toContain("tools");

	const denied = await post(port, `evil.example:${port}`);
	expect(denied.status).toBe(403);
});

test("refuses to start on a non-loopback bind without trusted hosts", () => {
	Object.assign(process.env, {
		TRUNK_MQ_HOST: "0.0.0.0",
		TRUNK_MQ_TRUNK_TOKEN: "test-trunk-token",
		TRUNK_MQ_GITHUB_TOKEN: "test-github-token",
	});
	expect(() => startServer()).toThrow("TRUNK_MQ_HOST must be a loopback host");
});
