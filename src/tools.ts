import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	discoverTrialRuns,
	foldVerdict,
	type TrialRun,
	type Verdict,
} from "./archaeology.ts";
import type { TrunkClient } from "./client.ts";
import type { GitHubClient } from "./github.ts";
import { reduceChecks } from "./reduce.ts";
import type { RepoRef } from "./types.ts";
export type ToolDependencies = {
	trunk: TrunkClient;
	github: GitHubClient;
};

const repoParams = {
	owner: z.string().default("RigelBuild"),
	repo: z.string(),
	targetBranch: z.string().default("main"),
};
const prParams = { ...repoParams, prNumber: z.number().int() };

type RepoArgs = RepoRef;
type PrArgs = RepoRef & { prNumber: number };

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function queueResult(queue: Awaited<ReturnType<TrunkClient["getQueue"]>>) {
	return {
		queueState: queue.state.toUpperCase(),
		config: {
			branch: queue.branch,
			concurrency: queue.concurrency,
			testingTimeoutMinutes: queue.testingTimeoutMinutes,
			mode: queue.mode,
			canOptimisticallyMerge: queue.canOptimisticallyMerge,
			pendingFailureDepth: queue.pendingFailureDepth,
			batch: queue.batch,
			batchingMaxWaitTimeMinutes: queue.batchingMaxWaitTimeMinutes,
			batchingMinSize: queue.batchingMinSize,
			createPrsForTestingBranches: queue.createPrsForTestingBranches,
			commentsEnabled: queue.commentsEnabled,
			commandsEnabled: queue.commandsEnabled,
			statusCheckEnabled: queue.statusCheckEnabled,
			extensionEnabled: queue.extensionEnabled,
			bisectionConcurrency: queue.bisectionConcurrency,
			requiredStatuses: queue.requiredStatuses,
			directMergeMode: queue.directMergeMode,
			optimizationMode: queue.optimizationMode,
			mergeMethod: queue.mergeMethod,
			testBranchConstructionMode: queue.testBranchConstructionMode,
			enqueueingLabel: queue.enqueueingLabel,
			labelCommandsEnabled: queue.labelCommandsEnabled,
			stateLabelsEnabled: queue.stateLabelsEnabled,
			notReadyTimeoutHours: queue.notReadyTimeoutHours,
		},
		entries: queue.enqueuedPullRequests.map((entry, index) => ({
			position: index + 1,
			prNumber: entry.prNumber,
			state: entry.state,
			stateChangedAt: entry.stateChangedAt,
		})),
	};
}

function runResult(run: TrialRun) {
	return {
		testRunId: run.testRunId,
		trialBranch: run.trialBranch,
		isBisection: run.isBisection,
		status: run.status,
		testedPullRequests: run.testedPullRequests,
		dependentPrs: run.dependentPrs,
		containsThisPr: run.containsThisPr,
	};
}

export function buildServer(deps: ToolDependencies): McpServer {
	const server = new McpServer({ name: "trunk-mq-mcp", version: "0.1.0" });
	server.registerTool(
		"get_queue",
		{ inputSchema: repoParams },
		async (args) => {
			const repo = args as RepoArgs;
			const queue = await deps.trunk.getQueue(repo);
			return textResult(queueResult(queue));
		},
	);
	server.registerTool(
		"get_pr_status",
		{ inputSchema: prParams },
		async (args) => {
			const repo = args as PrArgs;
			const { prNumber, ...repoRef } = repo;
			const submitted = await deps.trunk.getSubmittedPullRequest(repo);
			if (submitted === null) return textResult({ state: "not_enqueued" });
			const result: {
				state: string;
				stateChangedAt: string;
				prSha: string;
				prAuthor: string;
				isCurrentlySubmittedToQueue: boolean;
				readiness: typeof submitted.readiness;
				failure?: Record<string, unknown>;
			} = {
				state: submitted.state,
				stateChangedAt: submitted.stateChangedAt,
				prSha: submitted.prSha,
				prAuthor: submitted.prAuthor,
				isCurrentlySubmittedToQueue: submitted.isCurrentlySubmittedToQueue,
				readiness: submitted.readiness,
			};
			if (
				submitted.state === "failed" ||
				submitted.state === "pending_failure"
			) {
				let testRunId: string | undefined;
				let source: "verifiedByTestRun" | "trial-pr-archaeology";
				let runs: TrialRun[] = [];
				let createPrsForTestingBranches = false;
				if (submitted.verifiedByTestRun) {
					testRunId = submitted.verifiedByTestRun;
					source = "verifiedByTestRun";
				} else {
					source = "trial-pr-archaeology";
					const queue = await deps.trunk.getQueue(repoRef);
					createPrsForTestingBranches = queue.createPrsForTestingBranches;
					runs = await discoverTrialRuns(
						deps.github,
						deps.trunk,
						repoRef,
						prNumber,
					);
					testRunId =
						runs.find((run) => run.containsThisPr)?.testRunId ??
						runs[0]?.testRunId;
				}
				if (testRunId) {
					const details = await deps.trunk.getMergeQueueTestingDetails({
						...repoRef,
						testRunId,
					});
					const reduced = reduceChecks(details);
					const run = runs.find(
						(candidate) => candidate.testRunId === testRunId,
					);
					const verdict =
						source === "verifiedByTestRun"
							? "terminal"
							: foldVerdict(
									runs,
									submitted.state,
									prNumber,
									createPrsForTestingBranches,
								);
					result.failure = {
						testRunId,
						testRunSource: source,
						verdict,
						failingChecks: reduced.failing,
						rawCheckCount: reduced.rawCheckCount,
						...(reduced.reductionSkipped ? { reductionSkipped: true } : {}),
						...(submitted.state === "pending_failure" &&
						reduced.failing.length === 0 &&
						!reduced.reductionSkipped
							? { inconclusive: true }
							: {}),
						trialBranch: run?.trialBranch ?? details.testBranch,
					};
				} else {
					result.failure = {
						testRunSource: source,
						verdict: "undiscovered",
						reason: "No verified or discoverable testing run was found",
					};
				}
			}
			return textResult(result);
		},
	);
	server.registerTool("get_batch", { inputSchema: prParams }, async (args) => {
		const repo = args as PrArgs;
		const { prNumber, ...repoRef } = repo;
		const submitted = await deps.trunk.getSubmittedPullRequest(repo);
		if (submitted === null)
			return textResult({ verdict: "not_enqueued", runs: [] });
		const runs = await discoverTrialRuns(
			deps.github,
			deps.trunk,
			repoRef,
			prNumber,
		);
		const queue = await deps.trunk.getQueue(repoRef);
		const verdict = foldVerdict(
			runs,
			submitted.state,
			prNumber,
			queue.createPrsForTestingBranches,
		);
		return textResult({ runs: runs.map(runResult), verdict });
	});
	return server;
}

export type { Verdict };
