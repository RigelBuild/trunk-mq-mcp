import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { TrunkClient } from "../src/client.ts";

const writeEndpoints = [
	"/submitPullRequest",
	"/cancelPullRequest",
	"/restartTestsOnPullRequest",
	"/setImpactedTargets",
	"/createQueue",
	"/updateQueue",
	"/deleteQueue",
];

async function sourceFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

test("source has no Trunk write endpoints and client has exactly three reads", async () => {
	// existsSync, not Bun.file().exists(), which reads false for a directory and
	// would silently skip bin/ once the entrypoint lands there.
	const files = await sourceFiles("src");
	if (existsSync("bin")) files.push(...(await sourceFiles("bin")));
	for (const file of files) {
		const source = await Bun.file(file).text();
		for (const endpoint of writeEndpoints)
			expect(source).not.toContain(endpoint);
	}
	const methods = Object.getOwnPropertyNames(TrunkClient.prototype).filter(
		(name) => name !== "constructor",
	);
	expect(methods).toEqual([
		"getSubmittedPullRequest",
		"getQueue",
		"getMergeQueueTestingDetails",
	]);
});
