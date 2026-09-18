export type GitHubRepo = { owner: string; repo: string };

export type GitHubTrialPullRequest = {
	number: number;
	headRefName: string;
	createdAt?: string;
};

type SearchResponse = { items?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseItem(value: unknown): GitHubTrialPullRequest | undefined {
	if (!isRecord(value) || typeof value.number !== "number") return undefined;
	const head = isRecord(value.head) ? value.head : undefined;
	const ref = head && typeof head.ref === "string" ? head.ref : undefined;
	if (ref === undefined) return undefined;
	const createdAt = typeof value.created_at === "string" ? value.created_at : undefined;
	return { number: value.number, headRefName: ref, createdAt };
}

export class GitHubHttpError extends Error {
	readonly status: number;
	readonly body: string;
	constructor(status: number, body: string) {
		super(`GitHub API request failed with HTTP ${status}: ${body}`);
		this.name = "GitHubHttpError";
		this.status = status;
		this.body = body;
	}
}

export class GitHubClient {
	readonly #token: string;
	readonly #baseUrl: string;
	constructor(opts: { token?: string; baseUrl?: string }) {
		this.#token = opts.token ?? process.env.TRUNK_MQ_GITHUB_TOKEN ?? "";
		this.#baseUrl = opts.baseUrl ?? "https://api.github.com";
	}

	async searchTrialPullRequests(
		repo: GitHubRepo,
		prNumber: number,
	): Promise<GitHubTrialPullRequest[]> {
		const query = `repo:${repo.owner}/${repo.repo} is:pr state:closed head:trunk-merge/pr-${prNumber}`;
		const url = `${this.#baseUrl}/search/issues?q=${encodeURIComponent(query)}&per_page=100`;
		const response = await fetch(url, {
			method: "GET",
			headers: {
				accept: "application/vnd.github+json",
				...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
			},
		});
		if (!response.ok) throw new GitHubHttpError(response.status, await response.text());
		const payload: unknown = await response.json();
		if (!isRecord(payload)) return [];
		const items = (payload as SearchResponse).items;
		if (!Array.isArray(items)) return [];
		return items.flatMap((item) => {
			const parsed = parseItem(item);
			return parsed ? [parsed] : [];
		});
	}
}

export function githubClientFromEnv(): GitHubClient {
	return new GitHubClient({ token: process.env.TRUNK_MQ_GITHUB_TOKEN });
}
