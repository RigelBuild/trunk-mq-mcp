import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createHttpHandler } from "../bin/server.ts";
import type { TrunkClient } from "../src/client.ts";
import type { GitHubClient } from "../src/github.ts";
import type { ToolDependencies } from "../src/tools.ts";
import type { Queue } from "../src/types.ts";

const queue: Queue = {
	state: "running",
	branch: "main",
	concurrency: 5,
	testingTimeoutMinutes: 90,
	mode: "single",
	canOptimisticallyMerge: false,
	pendingFailureDepth: 0,
	batch: true,
	batchingMaxWaitTimeMinutes: 5,
	batchingMinSize: 5,
	createPrsForTestingBranches: true,
	commentsEnabled: true,
	commandsEnabled: true,
	statusCheckEnabled: true,
	extensionEnabled: true,
	bisectionConcurrency: 5,
	requiredStatuses: ["CI (pr)"],
	allowedBotSubmitters: [],
	batchingRules: [],
	directMergeMode: "always",
	optimizationMode: "off",
	mergeMethod: "squash",
	testBranchConstructionMode: "rename_temp_branch",
	enqueueingLabel: "trunk-merge-queue-submit",
	labelCommandsEnabled: true,
	stateLabelsEnabled: false,
	notReadyTimeoutHours: 24,
	enqueuedPullRequests: [
		{
			id: "entry-1",
			state: "testing",
			stateChangedAt: "2026-09-17T10:16:02.000Z",
			priorityValue: 100,
			priorityName: "medium",
			usedDefaultPriorityName: "medium",
			skipTheLine: false,
			noBatch: false,
			prTitle: "A test pull request",
			prNumber: 2670,
			prSha: "sha-1",
			prBaseBranch: "main",
			prAuthor: "rigel-mintaka",
		},
	],
};

function dependencies(): ToolDependencies {
	const trunk = {
		getQueue: async () => queue,
	} as unknown as TrunkClient;
	const github = {} as unknown as GitHubClient;
	return { trunk, github };
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Expected an ephemeral TCP address");
	}
	return address.port;
}

async function rpc(url: string, id: number, method: string, params: unknown) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
	});
	expect(response.ok).toBe(true);
	const body = await response.text();
	const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
	return JSON.parse(dataLine?.slice("data: ".length) ?? body) as {
		result?: {
			tools?: Array<{ name: string; inputSchema: Record<string, unknown> }>;
			content?: Array<{ text?: string }>;
		};
		error?: unknown;
	};
}

test("serves the public MCP tool catalog and serialized queue result", async () => {
	const server = createServer(createHttpHandler(dependencies()));
	const port = await listen(server);
	process.env.TRUNK_MQ_PORT = String(port);
	const url = `http://127.0.0.1:${port}/mcp`;

	try {
		const initialized = await rpc(url, 1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "mcp-integration-test", version: "1.0.0" },
		});
		expect(initialized.result).toMatchObject({
			serverInfo: { name: "trunk-mq-mcp" },
		});

		const listed = await rpc(url, 2, "tools/list", {});
		const tools = listed.result?.tools ?? [];
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"get_batch",
			"get_pr_status",
			"get_queue",
		]);
		const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
		for (const name of ["get_queue", "get_pr_status", "get_batch"]) {
			expect(schemas.get(name)).toMatchObject({ type: "object" });
			expect(schemas.get(name)?.properties).toMatchObject({
				owner: { type: "string", default: "RigelBuild" },
				repo: { type: "string" },
				targetBranch: { type: "string", default: "main" },
			});
		}
		expect(schemas.get("get_pr_status")?.properties).toMatchObject({
			prNumber: { type: "integer" },
		});

		const called = await rpc(url, 3, "tools/call", {
			name: "get_queue",
			arguments: { repo: "orion" },
		});
		const text = called.result?.content?.[0]?.text;
		expect(text).toBeString();
		expect(JSON.parse(text ?? "null")).toEqual({
			queueState: "RUNNING",
			config: {
				branch: "main",
				concurrency: 5,
				testingTimeoutMinutes: 90,
				mode: "single",
				canOptimisticallyMerge: false,
				pendingFailureDepth: 0,
				batch: true,
				batchingMaxWaitTimeMinutes: 5,
				batchingMinSize: 5,
				createPrsForTestingBranches: true,
				commentsEnabled: true,
				commandsEnabled: true,
				statusCheckEnabled: true,
				extensionEnabled: true,
				bisectionConcurrency: 5,
				requiredStatuses: ["CI (pr)"],
				directMergeMode: "always",
				optimizationMode: "off",
				mergeMethod: "squash",
				testBranchConstructionMode: "rename_temp_branch",
				enqueueingLabel: "trunk-merge-queue-submit",
				labelCommandsEnabled: true,
				stateLabelsEnabled: false,
				notReadyTimeoutHours: 24,
			},
			entries: [
				{
					position: 1,
					prNumber: 2670,
					state: "testing",
					stateChangedAt: "2026-09-17T10:16:02.000Z",
				},
			],
		});
	} finally {
		delete process.env.TRUNK_MQ_PORT;
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

afterEach(() => {
	delete process.env.TRUNK_MQ_PORT;
});
