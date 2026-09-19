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
};

class FakeRequest extends EventEmitter {
	url: string;
	method: string;

	constructor(url: string, method: string) {
		super();
		this.url = url;
		this.method = method;
	}

	setEncoding(_encoding: BufferEncoding): void {}
	resume(): void {}
}

function response(): [ServerResponse, FakeResponse] {
	const state: FakeResponse = { statusCode: 200, body: undefined };
	const res = {
		statusCode: state.statusCode,
		end(body?: string): void {
			state.statusCode = this.statusCode;
			state.body = body;
		},
	};
	return [res as unknown as ServerResponse, state];
}

function dependencies(): Parameters<typeof createHttpHandler>[0] {
	// SAFETY: malformed, rejected, and oversized requests return before dependencies are used.
	return {} as ToolDependencies;
}

async function request(
	url: string,
	method: string,
	body?: string,
): Promise<FakeResponse> {
	const req = new FakeRequest(url, method);
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
});

test("returns 400 for malformed JSON on the MCP endpoint", async () => {
	const got = await request("/mcp", "POST", "{not-json");
	expect(got.statusCode).toBe(400);
	expect(got.body).toBe("Invalid JSON");
});

test("returns 404 for non-POST and non-MCP requests", async () => {
	for (const [url, method] of [
		["/mcp", "GET"],
		["/other", "POST"],
	] as const) {
		const got = await request(url, method);
		expect(got.statusCode).toBe(404);
		expect(got.body).toBe("Not found");
	}
});

test("returns 413 when the request body exceeds the limit", async () => {
	const got = await request("/mcp", "POST", "x".repeat(MAX_BODY_BYTES + 1));
	expect(got.statusCode).toBe(413);
	expect(got.body).toBe("Request body too large");
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
