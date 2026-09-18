import { expect, test } from "bun:test";
import {
	discoverTrialRuns,
	foldVerdict,
	parseTrialBranch,
	type TrialRun,
} from "../src/archaeology.ts";
import type { TrunkClient } from "../src/client.ts";
import type { GitHubClient } from "../src/github.ts";
import type { TestingDetails } from "../src/types.ts";

const repo = { owner: "RigelBuild", repo: "orion", targetBranch: "main" };
const uuid = "12345678-1234-1234-1234-123456789abc";
const details = (
	createdAt: string,
	status: string,
	prs: number[],
): TestingDetails => ({
	requiredStatuses: [],
	requiredStatusesSource: "queue",
	testBranch: "trial",
	testBranchSha: "sha",
	createdAt,
	status,
	checkSuites: [],
	statusChecks: [],
	dependentPrs: [],
	testedPullRequests: prs.map((prNumber) => ({
		prNumber,
		prUrl: "",
		title: "",
	})),
});

for (const [branch, expected] of [
	[
		`trunk-merge/pr-91/${uuid}`,
		{ prNumber: 91, testRunId: uuid, isBisection: false },
	],
	[
		`trunk-merge/pr-91/${uuid}-bisection-2`,
		{ prNumber: 91, testRunId: uuid, isBisection: true },
	],
] as const) {
	test(`parses ${branch}`, () =>
		expect(parseTrialBranch(branch)).toEqual(expected));
}
test("rejects malformed branches", () =>
	expect(
		parseTrialBranch(`trunk-merge/pr-91/${uuid.slice(0, -1)}`),
	).toBeUndefined());

test("filters search bleed and orders by testing-details timestamp", async () => {
	const second = "22345678-1234-1234-1234-123456789abc";
	const hits = [
		{
			number: 912,
			headRefName: `trunk-merge/pr-912/${uuid}`,
			createdAt: "2026-01-01",
		},
		{
			number: 91,
			headRefName: `trunk-merge/pr-91/${second}-bisection-1`,
			createdAt: "2026-01-02",
		},
		{
			number: 91,
			headRefName: `trunk-merge/pr-91/${uuid}`,
			createdAt: "2026-01-03",
		},
	];
	const github = {
		searchTrialPullRequests: async () => hits,
	} as unknown as GitHubClient;
	const trunk = {
		getMergeQueueTestingDetails: async ({ testRunId }: { testRunId: string }) =>
			details(
				testRunId === uuid ? "2026-01-02T00:00:00Z" : "2026-01-03T00:00:00Z",
				"failed",
				[91],
			),
	} as unknown as TrunkClient;
	const runs = await discoverTrialRuns(github, trunk, repo, 91);
	expect(runs.map((run) => run.testRunId)).toEqual([second, uuid]);
	expect(runs[0]?.isBisection).toBe(true);
});

const run = (status: string, prs: number[], createdAt: string): TrialRun => ({
	testRunId: createdAt,
	trialBranch: "",
	isBisection: false,
	status,
	testedPullRequests: prs,
	dependentPrs: [],
	containsThisPr: prs.includes(91),
	createdAt,
});

test("folds terminal, ejected, merged, in-flight, unknown, and undiscovered", () => {
	expect(foldVerdict([run("failed", [91], "3")], "failed", 91)).toBe(
		"terminal",
	);
	expect(foldVerdict([run("failed", [88], "3")], "failed", 91)).toBe("ejected");
	expect(foldVerdict([], "merged", 91)).toBe("merged");
	expect(foldVerdict([], "failed", 91)).toBe("undiscovered");
	expect(foldVerdict([], "failed", 91, false)).toBe("unknown");
	expect(foldVerdict([run("testing", [91], "3")], "testing", 91)).toBe(
		"in-flight",
	);
	expect(foldVerdict([], "merged", 91)).toBe("merged");
});

test("three-trial narrowing ends terminal when newest run contains PR", () => {
	const runs = [
		run("failed", [91], "3"),
		run("failed", [933, 91], "2"),
		run("failed", [91, 898, 933, 943], "1"),
	];
	expect(foldVerdict(runs, "failed", 91)).toBe("terminal");
});
