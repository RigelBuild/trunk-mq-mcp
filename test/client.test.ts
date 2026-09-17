import { afterEach, expect, test } from "bun:test";
import { TrunkClient, TrunkHttpError } from "../src/client.ts";

type FetchInit = Parameters<typeof fetch>[1];
const repo = { owner: "RigelBuild", repo: "orion", targetBranch: "main" };
const submitted = await Bun.file(
	"test/fixtures/submitted-pr-testing.json",
).json();
const queue = await Bun.file("test/fixtures/queue-orion.json").json();
const details = await Bun.file(
	"test/fixtures/testing-details-in-progress.json",
).json();
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; init: FetchInit }> = [];
afterEach(() => {
	globalThis.fetch = originalFetch;
});
function mockFetch(
	handler: (url: string | Request | URL, init?: FetchInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(handler, { preconnect: originalFetch.preconnect });
}
test("shapes requests and parses responses", async () => {
	calls.length = 0;
	globalThis.fetch = mockFetch(async (url, init) => {
		calls.push({ url: String(url), init });
		const endpoint = String(url).split("/").pop();
		const body =
			endpoint === "getQueue"
				? queue
				: endpoint === "getSubmittedPullRequest"
					? submitted
					: details;
		return new Response(JSON.stringify(body), { status: 200 });
	});
	const client = new TrunkClient({
		token: "test-token",
		baseUrl: "https://example.test/v1",
	});
	const gotSubmitted = await client.getSubmittedPullRequest({
		...repo,
		prNumber: 2670,
	});
	const gotQueue = await client.getQueue(repo);
	const gotDetails = await client.getMergeQueueTestingDetails({
		...repo,
		testRunId: "run-id",
	});
	expect(gotSubmitted?.prNumber).toBe(2670);
	expect(gotQueue.state).toBe("running");
	expect(gotQueue.enqueuedPullRequests[0]?.prNumber).toBe(2670);
	expect(gotDetails.statusChecks).toHaveLength(88);
	expect(
		gotDetails.checkSuites.every((suite) => suite.checkRuns.length === 0),
	).toBe(true);
	expect(calls).toHaveLength(3);
	for (const call of calls) {
		expect(call.init?.method).toBe("POST");
		expect(new Headers(call.init?.headers).get("x-api-token")).toBe(
			"test-token",
		);
		const body = JSON.parse(String(call.init?.body)) as {
			repo: unknown;
			targetBranch: string;
		};
		expect(body.repo).toEqual({
			host: "github.com",
			owner: "RigelBuild",
			name: "orion",
		});
		expect(body.targetBranch).toBe("main");
	}
});
test("maps 404 to null", async () => {
	globalThis.fetch = mockFetch(
		async () => new Response("Not Found", { status: 404 }),
	);
	const client = new TrunkClient({ token: "test-token" });
	expect(
		await client.getSubmittedPullRequest({ ...repo, prNumber: 9999 }),
	).toBeNull();
});

test("404 is not swallowed outside getSubmittedPullRequest", async () => {
	globalThis.fetch = mockFetch(
		async () => new Response("Not Found", { status: 404 }),
	);
	const client = new TrunkClient({ token: "test-token" });
	await expect(client.getQueue(repo)).rejects.toMatchObject({ status: 404 });
	await expect(
		client.getMergeQueueTestingDetails({ ...repo, testRunId: "run-id" }),
	).rejects.toMatchObject({ status: 404 });
});
test("throws diagnostic non-404 errors", async () => {
	globalThis.fetch = mockFetch(
		async () => new Response("bad request", { status: 400 }),
	);
	const client = new TrunkClient({ token: "test-token" });
	await expect(client.getQueue(repo)).rejects.toMatchObject({
		status: 400,
		body: "bad request",
	});
	try {
		await client.getQueue(repo);
	} catch (error) {
		expect(error).toBeInstanceOf(TrunkHttpError);
	}
});
