import { describe, expect, test } from "bun:test";
import { reduceChecks } from "../src/reduce.ts";
import {
	TestingDetails,
	type TestingDetails as TestingDetailsType,
} from "../src/types.ts";

type CheckRunInput = {
	name: string;
	status: string;
	conclusion: string;
	url?: string;
};
type StatusCheckInput = { context: string; state: string; url?: string };

function details(input: {
	status?: string;
	requiredStatuses?: string[];
	checkRuns?: CheckRunInput[];
	statusChecks?: StatusCheckInput[];
}): TestingDetailsType {
	return TestingDetails.parse({
		requiredStatuses: input.requiredStatuses ?? ["rollup"],
		requiredStatusesSource: "merge_instance",
		testBranch: "trunk-merge/pr-1/run",
		testBranchSha: "abc",
		createdAt: "2026-01-01T00:00:00.000Z",
		status: input.status ?? "failed",
		checkSuites: [{ checkRuns: input.checkRuns ?? [] }],
		statusChecks: input.statusChecks ?? [],
		dependentPrs: [],
		testedPullRequests: [],
	});
}

const run = (name: string, conclusion: string): CheckRunInput => ({
	name,
	status: "completed",
	conclusion,
	url: `https://example.test/${name}`,
});

describe("reduceChecks", () => {
	test.each([
		{
			name: "14 raw checks reduce to microvm",
			input: details({
				checkRuns: [
					...Array.from({ length: 13 }, (_, index) =>
						run(`job-${index}`, "SUCCESS"),
					),
					run("microvm", "FAILURE"),
				],
			}),
			expected: ["microvm"] as string[],
		},
		{
			name: "no aggregator keeps the failing work job",
			input: details({
				requiredStatuses: [],
				checkRuns: [run("work", "FAILURE")],
			}),
			expected: ["work"] as string[],
		},
		{
			name: "all skipped is empty",
			input: details({
				status: "succeeded",
				checkRuns: [run("work", "SKIPPED")],
			}),
			expected: [] as string[],
		},
		{
			name: "aggregator name comes from the run",
			input: details({
				requiredStatuses: ["renamed-aggregator"],
				checkRuns: [
					run("renamed-aggregator", "FAILURE"),
					run("work", "FAILURE"),
				],
			}),
			expected: ["work"] as string[],
		},
		{
			name: "all failing checks required fails open",
			input: details({
				requiredStatuses: ["work-a", "work-b"],
				checkRuns: [run("work-a", "FAILURE"), run("work-b", "FAILURE")],
			}),
			expected: ["work-a", "work-b"] as string[],
		},
		{
			name: "timed out is a failing check",
			input: details({ checkRuns: [run("work", "TIMED_OUT")] }),
			expected: ["work"] as string[],
		},
	])("$name", ({ input, expected }) => {
		const result = reduceChecks(input);
		expect(result.failing.map((check) => check.name)).toEqual(expected);
	});

	test("flattens lowercase failure and error commit statuses", () => {
		const result = reduceChecks(
			details({
				requiredStatuses: [],
				statusChecks: [
					{
						context: "legacy-failure",
						state: "failure",
						url: "https://example.test/failure",
					},
					{
						context: "legacy-error",
						state: "error",
						url: "https://example.test/error",
					},
				],
			}),
		);
		expect(result.failing.map((check) => check.name)).toEqual([
			"legacy-failure",
			"legacy-error",
		]);
		expect(result.rawCheckCount).toBe(2);
	});

	test("failed verdict with empty classification fails open", () => {
		const result = reduceChecks(
			details({
				status: "failed",
				checkRuns: [run("work", "SUCCESS")],
			}),
		);
		expect(result).toEqual({
			failing: [],
			rawCheckCount: 1,
			reductionSkipped: true,
		});
	});
});
