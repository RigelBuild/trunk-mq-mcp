import type { RepoRef } from "./types.ts";
import { Queue, SubmittedPr, TestingDetails } from "./types.ts";

export class TrunkHttpError extends Error {
	readonly status: number;
	readonly body: string;
	constructor(status: number, body: string) {
		super(`Trunk API request failed with HTTP ${status}: ${body}`);
		this.name = "TrunkHttpError";
		this.status = status;
		this.body = body;
	}
}

type Request = RepoRef & { prNumber?: number; testRunId?: string };

export class TrunkClient {
	readonly #token: string;
	readonly #baseUrl: string;
	constructor(opts: { token: string; baseUrl?: string }) {
		this.#token = opts.token;
		this.#baseUrl = opts.baseUrl ?? "https://api.trunk.io/v1";
	}
	async getSubmittedPullRequest(
		req: RepoRef & { prNumber: number },
	): Promise<SubmittedPr | null> {
		const response = await this.#request("getSubmittedPullRequest", req);
		if (response.status === 404) return null;
		return SubmittedPr.parse(await response.json());
	}
	async getQueue(req: RepoRef): Promise<Queue> {
		const response = await this.#request("getQueue", req);
		return Queue.parse(await response.json());
	}
	async getMergeQueueTestingDetails(
		req: RepoRef & { testRunId: string },
	): Promise<TestingDetails> {
		const response = await this.#request("getMergeQueueTestingDetails", req);
		return TestingDetails.parse(await response.json());
	}
	async #request(endpoint: string, req: Request): Promise<Response> {
		const body: Record<string, unknown> = {
			repo: { host: "github.com", owner: req.owner, name: req.repo },
			targetBranch: req.targetBranch,
		};
		if (req.prNumber !== undefined) body.pr = { number: req.prNumber };
		if (req.testRunId !== undefined) body.testRunId = req.testRunId;
		const response = await fetch(`${this.#baseUrl}/${endpoint}`, {
			method: "POST",
			headers: {
				"x-api-token": this.#token,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (
			!response.ok &&
			!(endpoint === "getSubmittedPullRequest" && response.status === 404)
		) {
			throw new TrunkHttpError(response.status, await response.text());
		}
		return response;
	}
}
