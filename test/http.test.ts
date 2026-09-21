import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	configuredHost,
	createHttpHandler,
	MAX_BODY_BYTES,
} from "../bin/server.ts";
import type { ToolDependencies } from "../src/tools.ts";

type FakeResponse = {
	statusCode: number;
	body: string | undefined;
	allow: string | undefined;
};

class FakeRequest extends EventEmitter {
	url: string;
	method: string;
	headers: Record<string, string | undefined>;
	constructor(
		url: string,
		method: string,
		headers: Record<string, string | undefined> = {},
	) {
		super();
		this.url = url;
		this.method = method;
		this.headers = headers;
	}
	setEncoding(_encoding: BufferEncoding): void {}
	resume(): void {}
}

function response(): [ServerResponse, FakeResponse] {
	const state: FakeResponse = {
		statusCode: 200,
		body: undefined,
		allow: undefined,
	};
	const res = {
		statusCode: state.statusCode,
		headersSent: false,
		setHeader(name: string, value: string): void {
			if (name.toLowerCase() === "allow") state.allow = value;
		},
		end(body?: string): void {
			state.statusCode = this.statusCode;
			state.body = body;
			this.headersSent = true;
		},
		destroy(): void {
			this.headersSent = true;
		},
	};
	return [res as unknown as ServerResponse, state];
}

function dependencies(): Parameters<typeof createHttpHandler>[0] {
	return {} as ToolDependencies;
}

async function request(
	url: string,
	method: string,
	body?: string,
	headers: Record<string, string | undefined> = {},
): Promise<FakeResponse> {
	const req = new FakeRequest(url, method, headers);
	const [res, state] = response();
	const handled = createHttpHandler(dependencies())(
		req as unknown as IncomingMessage,
		res,
	);
	if (body !== undefined) {
		req.emit("data", body);
		req.emit("end");
	}
	await handled;
	return state;
}

afterEach(() => {
	delete process.env.TRUNK_MQ_HOST;
	delete process.env.TRUNK_MQ_PORT;
});

test("returns 400 for malformed JSON on the MCP endpoint", async () => {
	const got = await request("/mcp", "POST", "{not-json");
	expect(got.statusCode).toBe(400);
	expect(got.body).toBe("Invalid JSON");
});

test("returns 405 for unsupported MCP methods and 404 for unknown paths", async () => {
	const method = await request("/mcp", "GET");
	expect(method.statusCode).toBe(405);
	expect(method.allow).toBe("POST");
	const path = await request("/other", "POST");
	expect(path.statusCode).toBe(404);
	expect(path.body).toBe("Not found");
});

test("returns 413 when the request body exceeds the limit", async () => {
	const got = await request("/mcp", "POST", "x".repeat(MAX_BODY_BYTES + 1));
	expect(got.statusCode).toBe(413);
});

test("rejects non-loopback Host and Origin", async () => {
	const host = await request("/mcp", "POST", "{}", { host: "evil.example" });
	expect(host.statusCode).toBe(403);
	const origin = await request("/mcp", "POST", "{}", {
		origin: "https://evil.example",
	});
	expect(origin.statusCode).toBe(403);
});

test("returns 500 when request body emits an error", async () => {
	const req = new FakeRequest("/mcp", "POST");
	const [res, state] = response();
	const handled = createHttpHandler(dependencies())(
		req as unknown as IncomingMessage,
		res,
	);
	req.emit("error", new Error("client aborted"));
	await handled;
	expect(state.statusCode).toBe(500);
});

test("accepts loopback Host and Origin", async () => {
	const got = await request("/mcp", "POST", "{not-json", {
		host: "[::1]:4005",
		origin: "http://[::1]:4005",
	});
	expect(got.statusCode).toBe(400);
});

test("accepts configured loopback hosts", () => {
	for (const host of ["127.0.0.1", "localhost", "::1"]) {
		process.env.TRUNK_MQ_HOST = host;
		expect(configuredHost()).toBe(host);
	}
});

test("rejects a non-loopback configured host", () => {
	process.env.TRUNK_MQ_HOST = "0.0.0.0";
	expect(() => configuredHost()).toThrow(
		"TRUNK_MQ_HOST must be a loopback host",
	);
});
