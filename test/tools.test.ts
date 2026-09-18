import { expect, test } from "bun:test";
import type { TrunkClient } from "../src/client.ts";
import type { GitHubClient } from "../src/github.ts";
import { buildServer } from "../src/tools.ts";
import { type SubmittedPr, TestingDetails } from "../src/types.ts";

const details = await Bun.file(
	"test/fixtures/testing-details-in-progress.json",
).json();
const queue = await Bun.file("test/fixtures/queue-orion.json").json();
const submitted = await Bun.file(
	"test/fixtures/submitted-pr-testing.json",
).json();
const repo = { owner: "RigelBuild", repo: "orion", targetBranch: "main" };
type Tool = {
	handler: (
		args: Record<string, unknown>,
		extra: never,
	) => Promise<{ content: Array<{ text: string }> }>;
};
function tools(trunk: TrunkClient, github: GitHubClient): Record<string, Tool> {
	const server = buildServer({ trunk, github });
	return (server as unknown as { _registeredTools: Record<string, Tool> })
		._registeredTools;
}
function toolNamed(all: Record<string, Tool>, name: string): Tool {
	const tool = all[name];
	if (!tool) throw new Error(`Tool not registered: ${name}`);
	return tool;
}
function fakeTrunk(overrides: Partial<TrunkClient>): TrunkClient {
	// SAFETY: tests provide every method invoked by the selected tool callback.
	return overrides as unknown as TrunkClient;
}
function fakeGithub(
	search: GitHubClient["searchTrialPullRequests"],
): GitHubClient {
	// SAFETY: tests provide the sole GitHub method used by archaeology.
	return { searchTrialPullRequests: search } as unknown as GitHubClient;
}
function result(tool: Tool, args: Record<string, unknown>) {
	return tool
		.handler(args, {} as never)
		.then(
			(response) =>
				JSON.parse(response.content[0]?.text ?? "null") as Record<
					string,
					unknown
				>,
		);
}

const trialBranch = "trunk-merge/pr-912/123e4567-e89b-12d3-a456-426614174000";
const trial = {
	number: 99,
	headRefName: trialBranch,
	createdAt: "2026-01-01T00:00:00Z",
};

test("get_queue returns frozen queue shape", async () => {
	const got = await result(
		toolNamed(
			tools(
				fakeTrunk({ getQueue: async () => queue }),
				fakeGithub(async () => []),
			),
			"get_queue",
		),
		repo,
	);
	expect(got).toMatchObject({
		queueState: "RUNNING",
		config: { mode: queue.mode, batch: queue.batch },
	});
	expect(got.entries).toBeArray();
});

test("get_pr_status maps null submission to not_enqueued", async () => {
	const got = await result(
		toolNamed(
			tools(
				fakeTrunk({ getSubmittedPullRequest: async () => null }),
				fakeGithub(async () => []),
			),
			"get_pr_status",
		),
		{ ...repo, prNumber: 912 },
	);
	expect(got).toEqual({ state: "not_enqueued" });
});

test("get_pr_status uses archaeology when verifiedByTestRun is null", async () => {
	const detailsValue = TestingDetails.parse(details);
	const got = await result(
		toolNamed(
			tools(
				fakeTrunk({
					getSubmittedPullRequest: async () => ({
						...submitted,
						state: "failed",
					}),
					getMergeQueueTestingDetails: async () => detailsValue,
				}),
				fakeGithub(async () => [trial]),
			),
			"get_pr_status",
		),
		{ ...repo, prNumber: 912 },
	);
	expect(got.failure).toMatchObject({
		testRunSource: "trial-pr-archaeology",
		testRunId: "123e4567-e89b-12d3-a456-426614174000",
	});
});

test("get_batch returns runs and undiscovered verdict", async () => {
	const got = await result(
		toolNamed(
			tools(
				fakeTrunk({
					getSubmittedPullRequest: async () =>
						({ ...submitted, state: "failed" }) as SubmittedPr,
					getMergeQueueTestingDetails: async () =>
						TestingDetails.parse(details),
				}),
				fakeGithub(async () => []),
			),
			"get_batch",
		),
		{ ...repo, prNumber: 912 },
	);
	expect(got.verdict).toBe("undiscovered");
	expect(got.runs).toEqual([]);
});

test("get_batch reports unknown when submission is absent and no runs", async () => {
	const got = await result(
		toolNamed(
			tools(
				fakeTrunk({
					getSubmittedPullRequest: async () => null,
				}),
				fakeGithub(async () => []),
			),
			"get_batch",
		),
		{ ...repo, prNumber: 912 },
	);
	expect(got.verdict).toBe("unknown");
});
