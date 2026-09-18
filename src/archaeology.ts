import type { GitHubClient, GitHubRepo } from "./github.ts";
import type { TrunkClient } from "./client.ts";
import type { TestingDetails } from "./types.ts";

const TRIAL_BRANCH = /^trunk-merge\/pr-(\d+)\/([0-9a-f-]{36})(-bisection.*)?$/;

export type TrialRun = {
	testRunId: string;
	trialBranch: string;
	isBisection: boolean;
	status: string;
	testedPullRequests: number[];
	dependentPrs: number[];
	containsThisPr: boolean;
	createdAt: string;
};

export type Verdict =
	| "terminal"
	| "ejected"
	| "merged"
	| "in-flight"
	| "unknown"
	| "undiscovered";

export type ParsedTrialBranch = {
	prNumber: number;
	testRunId: string;
	isBisection: boolean;
};

export function parseTrialBranch(branch: string): ParsedTrialBranch | undefined {
	const match = TRIAL_BRANCH.exec(branch);
	if (!match) return undefined;
	const prNumber = Number(match[1]);
	if (!Number.isSafeInteger(prNumber)) return undefined;
	return {
		prNumber,
		testRunId: match[2] ?? "",
		isBisection: match[3] !== undefined,
	};
}

export async function discoverTrialRuns(
	github: GitHubClient,
	trunk: TrunkClient,
	repo: GitHubRepo & { targetBranch: string },
	prNumber: number,
): Promise<TrialRun[]> {
	const hits = await github.searchTrialPullRequests(repo, prNumber);
	const candidates = hits.flatMap((hit) => {
		const parsed = parseTrialBranch(hit.headRefName);
		return parsed && parsed.prNumber === prNumber ? [{ hit, parsed }] : [];
	});
	const runs = await Promise.all(
		candidates.map(async ({ hit, parsed }) => {
			const details = await trunk.getMergeQueueTestingDetails({
				...repo,
				testRunId: parsed.testRunId,
			});
			return trialRunFromDetails(details, hit.headRefName, parsed, prNumber);
		}),
	);
	return runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function trialRunFromDetails(
	details: TestingDetails,
	trialBranch: string,
	parsed: ParsedTrialBranch,
	prNumber: number,
): TrialRun {
	const testedPullRequests = details.testedPullRequests.map((pr) => pr.prNumber);
	const dependentPrs = details.dependentPrs.flatMap((value) => {
		if (typeof value === "number") return [value];
		if (typeof value === "object" && value !== null && "prNumber" in value) {
			const pr = value.prNumber;
			return typeof pr === "number" ? [pr] : [];
		}
		return [];
	});
	return {
		testRunId: parsed.testRunId,
		trialBranch,
		isBisection: parsed.isBisection,
		status: details.status,
		testedPullRequests,
		dependentPrs,
		containsThisPr: testedPullRequests.includes(prNumber),
		createdAt: details.createdAt,
	};
}

export function foldVerdict(
	runs: readonly TrialRun[],
	state: string,
	prNumber: number,
	createPrsForTestingBranches = true,
): Verdict {
	if (!createPrsForTestingBranches) return "unknown";
	if (state === "merged") return "merged";
	if (runs.length === 0) return state === "failed" || state === "pending_failure" ? "undiscovered" : "unknown";
	const newest = runs[0];
	if (newest === undefined) return "unknown";
	if (newest.status === "failed" || newest.status === "pending_failure") {
		return newest.containsThisPr ? "terminal" : "ejected";
	}
	const containing = runs.find((run) => run.testedPullRequests.includes(prNumber));
	if (containing && (containing.status === "failed" || containing.status === "pending_failure")) {
		return "terminal";
	}
	return "in-flight";
}
