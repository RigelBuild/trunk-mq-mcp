import type { ReducedCheck, TestingDetails } from "./types.ts";

export type ReducedChecks = {
	failing: ReducedCheck[];
	rawCheckCount: number;
	reductionSkipped: boolean;
};

type CheckRun = {
	name: string;
	status: string;
	conclusion: string;
	url?: string;
};

const GREEN_CHECK_CONCLUSIONS: Record<string, true> = {
	success: true,
	neutral: true,
	skipped: true,
};
const GREEN_STATUS_STATES: Record<string, true> = {
	success: true,
	pending: true,
	expected: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	return typeof value === "string" ? value : "";
}

function toCheckRun(value: unknown): CheckRun | undefined {
	if (!isRecord(value)) return undefined;
	const name = stringField(value, "name");
	const status = stringField(value, "status");
	const conclusion = stringField(value, "conclusion");
	if (name === "" || status === "" || conclusion === "") return undefined;
	const url = value.url;
	return typeof url === "string"
		? { name, status, conclusion, url }
		: { name, status, conclusion };
}

function toStatusCheck(value: unknown): CheckRun | undefined {
	if (!isRecord(value)) return undefined;
	const name = stringField(value, "context");
	const conclusion = stringField(value, "state");
	if (name === "" || conclusion === "") return undefined;
	const url = value.url;
	return typeof url === "string"
		? { name, status: conclusion, conclusion, url }
		: { name, status: conclusion, conclusion };
}

function isGreen(row: CheckRun, statusCheck: boolean): boolean {
	const value = row.conclusion.toLowerCase();
	return statusCheck
		? GREEN_STATUS_STATES[value] === true
		: GREEN_CHECK_CONCLUSIONS[value] === true;
}

export function reduceChecks(details: TestingDetails): ReducedChecks {
	const rawRows: Array<{ row: CheckRun; statusCheck: boolean }> = [];
	for (const suite of details.checkSuites) {
		for (const value of suite.checkRuns) {
			const row = toCheckRun(value);
			if (row) rawRows.push({ row, statusCheck: false });
		}
	}
	for (const value of details.statusChecks) {
		const row = toStatusCheck(value);
		if (row) rawRows.push({ row, statusCheck: true });
	}

	const rawCheckCount = rawRows.length;
	const nonSuccess = rawRows.filter(
		({ row, statusCheck }) => !isGreen(row, statusCheck),
	);
	const requiredStatuses = new Set(details.requiredStatuses);
	const reduced = nonSuccess
		.filter(({ row }) => !requiredStatuses.has(row.name))
		.map(({ row }) => row);
	const verdictFailed = details.status.toLowerCase() === "failed";
	if (verdictFailed && reduced.length === 0) {
		return {
			failing: nonSuccess.map(({ row }) => row),
			rawCheckCount,
			reductionSkipped: true,
		};
	}
	return { failing: reduced, rawCheckCount, reductionSkipped: false };
}
