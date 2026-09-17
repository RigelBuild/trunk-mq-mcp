import { z } from "zod";

export const PrState = z.enum([
	"not_ready",
	"pending",
	"testing",
	"tests_passed",
	"merged",
	"failed",
	"cancelled",
	"pending_failure",
]);
export type PrState = z.infer<typeof PrState>;

export const QueueState = z.enum([
	"running",
	"paused",
	"draining",
	"switching_modes",
]);
export type QueueState = z.infer<typeof QueueState>;

const QueueEntry = z.object({
	id: z.string(),
	state: PrState,
	stateChangedAt: z.string(),
	priorityValue: z.number(),
	priorityName: z.string(),
	usedDefaultPriorityName: z.string(),
	skipTheLine: z.boolean(),
	noBatch: z.boolean(),
	prTitle: z.string(),
	prNumber: z.number(),
	prSha: z.string(),
	prBaseBranch: z.string(),
	prAuthor: z.string(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

export const Queue = z.object({
	state: QueueState,
	branch: z.string(),
	concurrency: z.number(),
	testingTimeoutMinutes: z.number(),
	mode: z.string(),
	canOptimisticallyMerge: z.boolean(),
	pendingFailureDepth: z.number(),
	batch: z.boolean(),
	batchingMaxWaitTimeMinutes: z.number(),
	batchingMinSize: z.number(),
	createPrsForTestingBranches: z.boolean(),
	commentsEnabled: z.boolean(),
	commandsEnabled: z.boolean(),
	statusCheckEnabled: z.boolean(),
	extensionEnabled: z.boolean(),
	bisectionConcurrency: z.number(),
	requiredStatuses: z.array(z.string()),
	allowedBotSubmitters: z.array(z.unknown()),
	batchingRules: z.array(z.unknown()),
	directMergeMode: z.string(),
	optimizationMode: z.string(),
	mergeMethod: z.string(),
	testBranchConstructionMode: z.string(),
	enqueueingLabel: z.string(),
	labelCommandsEnabled: z.boolean(),
	stateLabelsEnabled: z.boolean(),
	notReadyTimeoutHours: z.number(),
	enqueuedPullRequests: z.array(QueueEntry),
});
export type Queue = z.infer<typeof Queue>;

// Passed through verbatim to callers, so it must not be narrowed to the four
// keys one fixture happened to carry: a stricter schema would drop the rest.
const Readiness = z.looseObject({
	hasImpactedTargets: z.boolean(),
	requiresImpactedTargets: z.boolean(),
	doesBaseBranchMatch: z.boolean(),
	gitHubMergeability: z.string(),
});
export const SubmittedPr = z.object({
	id: z.string(),
	state: PrState,
	stateChangedAt: z.string(),
	priorityValue: z.number(),
	priorityName: z.string(),
	usedDefaultPriorityName: z.string(),
	skipTheLine: z.boolean(),
	noBatch: z.boolean(),
	prTitle: z.string(),
	prNumber: z.number(),
	prSha: z.string(),
	prBaseBranch: z.string(),
	prAuthor: z.string(),
	readiness: Readiness,
	forceEnqueued: z.boolean(),
	isCurrentlySubmittedToQueue: z.boolean(),
	verifiedByTestRun: z.string().nullable(),
});
export type SubmittedPr = z.infer<typeof SubmittedPr>;

// No live run has yet produced a checkRun row (every measured suite carries an
// empty array), so its fields are unmeasured and typing them would fail closed
// on the first real one. T3's reducer reads statusChecks, which is populated.
const CheckSuite = z.looseObject({ checkRuns: z.array(z.unknown()) });
const StatusCheck = z.object({
	context: z.string(),
	url: z.string(),
	state: z.string(),
});
const TestedPullRequest = z.object({
	prNumber: z.number(),
	prUrl: z.string(),
	title: z.string(),
});
export const TestingDetails = z.object({
	requiredStatuses: z.array(z.string()),
	requiredStatusesSource: z.string(),
	testBranch: z.string(),
	testBranchSha: z.string(),
	createdAt: z.string(),
	status: z.string(),
	checkSuites: z.array(CheckSuite),
	statusChecks: z.array(StatusCheck),
	dependentPrs: z.array(z.unknown()),
	testedPullRequests: z.array(TestedPullRequest),
});
export type TestingDetails = z.infer<typeof TestingDetails>;

export type RepoRef = { owner: string; repo: string; targetBranch: string };
// Per the design record, whose field comments derive each key from checkRuns[].
// The populated surface in practice is statusChecks[], whose keys differ
// (context/state/url), so the reducer must map rather than spread.
export type ReducedCheck = {
	name: string;
	status: string;
	conclusion: string;
	url?: string;
};
