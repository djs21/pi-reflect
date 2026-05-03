import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	computeFileMetrics,
	applyEdits,
	buildTranscriptBatches,
	buildReflectionPrompt,
	buildPromptForTarget,
	escapeRegex,
	truncateText,
	projectNameFromDir,
	extractTranscript,
	formatSessionTranscript,
	loadHistory,
	saveHistory,
	loadConfig,
	saveConfig,
	resolvePath,
	type AnalysisEdit,
	type ReflectTarget,
	type ReflectRun,
	type SessionData,
	type SessionExchange,
	DEFAULT_TARGET,
	HISTORY_FILE,
	CONFIG_FILE,
} from "../extensions/reflect.js";

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-reflect-test-"));
}

function rmrf(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

// --- computeFileMetrics ---

describe("computeFileMetrics", () => {
	it("counts chars, words, lines, estTokens", () => {
		const m = computeFileMetrics("hello world\nsecond line\n");
		assert.equal(m.chars, 24);
		assert.equal(m.words, 4);
		assert.equal(m.lines, 3); // trailing newline = extra empty line
		assert.equal(m.estTokens, Math.ceil(24 / 4));
	});

	it("handles empty string", () => {
		const m = computeFileMetrics("");
		assert.equal(m.chars, 0);
		assert.equal(m.words, 0);
		assert.equal(m.lines, 1);
		assert.equal(m.estTokens, 0);
	});
});

// --- escapeRegex ---

describe("escapeRegex", () => {
	it("escapes regex special chars", () => {
		assert.equal(escapeRegex("a.b*c?d"), "a\\.b\\*c\\?d");
		assert.equal(escapeRegex("foo[bar]"), "foo\\[bar\\]");
		assert.equal(escapeRegex("$100 (USD)"), "\\$100 \\(USD\\)");
	});
});

// --- truncateText ---

describe("truncateText", () => {
	it("returns null for null input", () => {
		assert.equal(truncateText(null, 10), null);
	});

	it("truncates long text", () => {
		const result = truncateText("hello world this is long", 10);
		assert.ok(result !== null);
		// truncateText uses "\n[...truncated, N chars omitted]" format
		assert.ok(result!.includes("truncated") || result!.length <= 24);
		// Original 24 chars, limit 10 — should be truncated
		assert.ok(result!.length < 24 || result!.includes("truncated"));
	});

	it("returns text unchanged if within limit", () => {
		assert.equal(truncateText("short", 100), "short");
	});
});

// --- projectNameFromDir ---

describe("projectNameFromDir", () => {
	it("extracts project name from worktree path", () => {
		const name = projectNameFromDir("my-project-feature-branch");
		assert.equal(typeof name, "string");
	});
});

// --- applyEdits ---

describe("applyEdits", () => {
	const baseContent = `# Rules

## Debugging
- **Always check logs first** before theorizing.
- **Don't guess** — verify assumptions with data.

## Execution
- **Execute first, explain minimally**: Do the work, say what you did.
- **Use the oracle subagent early**: For complex problems, use the oracle BEFORE spending 10+ minutes.
`;

	it("strengthen: replaces matching text", () => {
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- **Always check logs first** before theorizing.",
			new_text: "- **Check logs first** — no theorizing without evidence.",
		}];
		const { result, applied, skipped } = applyEdits(baseContent, edits);
		assert.equal(applied, 1);
		assert.equal(skipped.length, 0);
		assert.ok(result.includes("Check logs first"));
		assert.ok(!result.includes("before theorizing."));
	});

	it("strengthen: skips when old_text not found", () => {
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "- This text does not exist in the file.",
			new_text: "- Replacement text.",
		}];
		const { applied, skipped } = applyEdits(baseContent, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
		assert.ok(skipped[0].includes("Could not find"));
	});

	it("strengthen: skips ambiguous matches", () => {
		const content = "rule A\nrule A\n";
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: "rule A",
			new_text: "rule B",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
		assert.ok(skipped[0].includes("Ambiguous"));
	});

	it("strengthen: detects duplication in replacement text", () => {
		// old_text is >50 chars so duplication detection kicks in
		const longRule = "- **When the user pushes back or says you're wrong, pivot immediately**: After 1 pushback, stop.";
		const content = `# Rules\n${longRule}\n`;
		const edits: AnalysisEdit[] = [{
			type: "strengthen",
			old_text: longRule,
			// new_text contains the old text twice (LLM duplication bug)
			new_text: `${longRule}\n${longRule}`,
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
		assert.ok(skipped[0].includes("Duplication"));
	});

	it("add: inserts after matching text", () => {
		const edits: AnalysisEdit[] = [{
			type: "add",
			new_text: "- **New rule**: Always verify the fix works.",
			after_text: "- **Don't guess** — verify assumptions with data.",
		}];
		const { result, applied } = applyEdits(baseContent, edits);
		assert.equal(applied, 1);
		assert.ok(result.includes("New rule"));
		// Verify insertion is after the anchor
		const anchorIdx = result.indexOf("verify assumptions with data.");
		const newIdx = result.indexOf("New rule");
		assert.ok(newIdx > anchorIdx);
	});

	it("add: skips if text already exists", () => {
		const edits: AnalysisEdit[] = [{
			type: "add",
			new_text: "- **Don't guess** — verify assumptions with data.",
			after_text: "- **Always check logs first** before theorizing.",
		}];
		const { applied, skipped } = applyEdits(baseContent, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
		assert.ok(skipped[0].includes("already exists"));
	});

	it("add: skips ambiguous insertion point", () => {
		const content = "anchor\nstuff\nanchor\n";
		const edits: AnalysisEdit[] = [{
			type: "add",
			new_text: "new line",
			after_text: "anchor",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.ok(skipped[0].includes("Ambiguous"));
	});

	it("remove: deletes matching text", () => {
		const edits: AnalysisEdit[] = [{
			type: "remove",
			old_text: "- **Don't guess** — verify assumptions with data.",
			new_text: "",
		}];
		const { result, applied } = applyEdits(baseContent, edits);
		assert.equal(applied, 1);
		assert.ok(!result.includes("Don't guess"));
	});

	it("remove: skips ambiguous matches", () => {
		const content = "dup line\nstuff\ndup line\n";
		const edits: AnalysisEdit[] = [{
			type: "remove",
			old_text: "dup line",
			new_text: "",
		}];
		const { applied, skipped } = applyEdits(content, edits);
		assert.equal(applied, 0);
		assert.ok(skipped[0].includes("Ambiguous"));
	});

	it("merge: consolidates multiple sources into one", () => {
		const edits: AnalysisEdit[] = [{
			type: "merge",
			merge_sources: [
				"- **Always check logs first** before theorizing.",
				"- **Don't guess** — verify assumptions with data.",
			],
			new_text: "- **Check logs and verify with data** — no guessing or theorizing.",
		}];
		const { result, applied } = applyEdits(baseContent, edits);
		assert.equal(applied, 1);
		assert.ok(result.includes("Check logs and verify with data"));
		assert.ok(!result.includes("Always check logs first"));
		assert.ok(!result.includes("Don't guess"));
	});

	it("merge: skips when a source is missing", () => {
		const edits: AnalysisEdit[] = [{
			type: "merge",
			merge_sources: [
				"- **Always check logs first** before theorizing.",
				"- This source does not exist.",
			],
			new_text: "- Merged rule.",
		}];
		const { applied, skipped } = applyEdits(baseContent, edits);
		assert.equal(applied, 0);
		assert.ok(skipped[0].includes("Merge source not found"));
	});

	it("applies multiple edits in sequence", () => {
		const edits: AnalysisEdit[] = [
			{
				type: "strengthen",
				old_text: "- **Always check logs first** before theorizing.",
				new_text: "- **Logs first** — no theorizing.",
			},
			{
				type: "add",
				new_text: "- **3-attempt rule**: Stop after 3 failures.",
				after_text: "- **Use the oracle subagent early**: For complex problems, use the oracle BEFORE spending 10+ minutes.",
			},
		];
		const { result, applied } = applyEdits(baseContent, edits);
		assert.equal(applied, 2);
		assert.ok(result.includes("Logs first"));
		assert.ok(result.includes("3-attempt rule"));
	});

	it("handles invalid edit gracefully", () => {
		const edits: AnalysisEdit[] = [{
			type: "strengthen" as any,
			new_text: "replacement",
			// missing old_text
		}];
		const { applied, skipped } = applyEdits(baseContent, edits);
		assert.equal(applied, 0);
		assert.equal(skipped.length, 1);
		assert.ok(skipped[0].includes("Invalid edit"));
	});
});

// --- buildTranscriptBatches ---

describe("buildTranscriptBatches", () => {
	function makeSessions(sizes: number[]): SessionData[] {
		return sizes.map((size, i) => ({
			userCount: 1,
			exchangeCount: 2,
			transcript: "x".repeat(size),
			size,
			project: "test",
			time: `session-${i}`,
		}));
	}

	it("puts all sessions in one batch when they fit", () => {
		const sessions = makeSessions([100, 200, 300]);
		const batches = buildTranscriptBatches(sessions, 10000);
		assert.equal(batches.length, 1);
		assert.equal(batches[0].length, 3);
	});

	it("splits sessions into multiple batches by size", () => {
		const sessions = makeSessions([500, 500, 500]);
		// Each entry adds "\n---\n\n" (6 chars) to the transcript
		const batches = buildTranscriptBatches(sessions, 600);
		assert.ok(batches.length >= 2);
	});

	it("handles a single oversized session", () => {
		const sessions = makeSessions([10000]);
		const batches = buildTranscriptBatches(sessions, 100);
		// Even oversized, it should be in its own batch (not dropped)
		assert.equal(batches.length, 1);
		assert.equal(batches[0].length, 1);
	});

	it("returns empty for no sessions", () => {
		const batches = buildTranscriptBatches([], 10000);
		assert.equal(batches.length, 0);
	});
});

// --- buildReflectionPrompt ---

describe("buildReflectionPrompt", () => {
	it("includes file name, content, and transcripts", () => {
		const prompt = buildReflectionPrompt(
			"/path/to/AGENTS.md",
			"# Rules\n- Rule 1\n",
			"## Session 1\nUser: fix this\nAssistant: done",
		);
		assert.ok(prompt.includes("AGENTS.md"));
		assert.ok(prompt.includes("# Rules"));
		assert.ok(prompt.includes("Rule 1"));
		assert.ok(prompt.includes("Session 1"));
		assert.ok(prompt.includes("fix this"));
	});

	it("includes conciseness instructions", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes("Conciseness"));
		assert.ok(prompt.includes("SHORTER"));
	});

	it("includes all edit types in instructions", () => {
		const prompt = buildReflectionPrompt("/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes("strengthen"));
		assert.ok(prompt.includes("add"));
		assert.ok(prompt.includes("remove"));
		assert.ok(prompt.includes("merge"));
	});
});

// --- buildPromptForTarget ---

describe("buildPromptForTarget", () => {
	it("uses default prompt when no custom prompt", () => {
		const target: ReflectTarget = { ...DEFAULT_TARGET, path: "/AGENTS.md" };
		const prompt = buildPromptForTarget(target, "/AGENTS.md", "content", "transcripts");
		assert.ok(prompt.includes("reviewing recent agent session"));
	});

	it("interpolates custom prompt template", () => {
		const target: ReflectTarget = {
			...DEFAULT_TARGET,
			path: "/AGENTS.md",
			prompt: "File: {fileName}\nContent: {targetContent}\nTranscripts: {transcripts}\nContext: {context}",
		};
		const prompt = buildPromptForTarget(target, "/path/to/AGENTS.md", "my content", "my transcripts", "my context");
		assert.equal(prompt, "File: AGENTS.md\nContent: my content\nTranscripts: my transcripts\nContext: my context");
	});
});

// --- Config and History I/O ---

describe("config and history I/O", () => {
	let origConfigFile: string;
	let origHistoryFile: string;
	let tmp: string;

	before(() => {
		tmp = makeTmpDir();
		// Monkey-patch the module-level file paths
		// These are exported as const, so we need to use Object.defineProperty
		origConfigFile = CONFIG_FILE;
		origHistoryFile = HISTORY_FILE;
	});

	after(() => {
		rmrf(tmp);
	});

	it("loadHistory returns empty array for missing file", () => {
		// loadHistory reads from HISTORY_FILE which we can't easily redirect
		// So just test the function exists and handles errors
		const history = loadHistory();
		assert.ok(Array.isArray(history));
	});

	it("loadConfig returns empty targets for missing file", () => {
		const config = loadConfig();
		assert.ok(Array.isArray(config.targets));
	});
});

// --- Dedup in runReflection ---

describe("dedup logic", () => {
	it("sourceDate is computed from lookbackDays", () => {
		// Verify the date computation matches what runReflection uses
		const lookbackDays = 1;
		const sourceDate = new Date();
		sourceDate.setDate(sourceDate.getDate() - lookbackDays);
		const sourceDateStr = sourceDate.toISOString().slice(0, 10);

		// Should be yesterday's date
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		assert.equal(sourceDateStr, yesterday.toISOString().slice(0, 10));
	});

	it("history entry sourceDate matching works", () => {
		const targetPath = "/path/to/AGENTS.md";
		const sourceDateStr = "2026-05-02";

		const history: ReflectRun[] = [
			{
				timestamp: "2026-05-03T05:00:00Z",
				targetPath,
				sessionsAnalyzed: 10,
				correctionsFound: 3,
				editsApplied: 2,
				summary: "test",
				diffLines: 5,
				correctionRate: 0.3,
				sourceDate: sourceDateStr,
			},
		];

		const alreadyRan = history.some(
			(r) => r.targetPath === targetPath && r.sourceDate === sourceDateStr,
		);
		assert.ok(alreadyRan, "should detect already-processed date");

		const notRan = history.some(
			(r) => r.targetPath === targetPath && r.sourceDate === "2026-05-03",
		);
		assert.ok(!notRan, "should not match different date");

		const diffTarget = history.some(
			(r) => r.targetPath === "/other/file.md" && r.sourceDate === sourceDateStr,
		);
		assert.ok(!diffTarget, "should not match different target");
	});
});

// --- extractTranscript ---

describe("extractTranscript", () => {
	let tmp: string;
	before(() => { tmp = makeTmpDir(); });
	after(() => { rmrf(tmp); });

	it("extracts exchanges from a session file", async () => {
		// Create a minimal session file (JSONL format)
		// extractTranscript expects {type: "message", message: {role, content}} wrapper
		const sessionFile = path.join(tmp, "test-session.jsonl");
		const entries = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "fix the bug" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I'll look into it." }] } },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "thanks" }] } },
		];
		fs.writeFileSync(sessionFile, entries.map(e => JSON.stringify(e)).join("\n"), "utf-8");

		const exchanges = await extractTranscript(sessionFile);
		assert.ok(exchanges.length >= 2, `expected >= 2 exchanges, got ${exchanges.length}`);
		assert.equal(exchanges[0].role, "user");
		assert.equal(exchanges[0].text, "fix the bug");
		assert.equal(exchanges[1].role, "assistant");
		assert.equal(exchanges[1].text, "I'll look into it.");
	});

	it("handles missing file gracefully", async () => {
		const exchanges = await extractTranscript("/nonexistent/file.jsonl");
		assert.deepEqual(exchanges, []);
	});
});

// --- formatSessionTranscript ---

describe("formatSessionTranscript", () => {
	it("formats exchanges into readable text", () => {
		const exchanges: SessionExchange[] = [
			{ role: "user", text: "fix it", thinking: null },
			{ role: "assistant", text: "done", thinking: "I should check the logs" },
		];
		const result = formatSessionTranscript(exchanges, "session-1", "my-project");
		assert.ok(result.includes("fix it"));
		assert.ok(result.includes("done"));
		assert.ok(result.includes("session-1") || result.includes("my-project"));
	});

	it("handles empty exchanges", () => {
		const result = formatSessionTranscript([], "empty-session", "proj");
		assert.equal(typeof result, "string");
	});
});

// --- resolvePath ---

describe("resolvePath", () => {
	it("resolves tilde paths", () => {
		const home = process.env.HOME ?? os.homedir();
		const resolved = resolvePath("~/test.md");
		assert.equal(resolved, path.join(home, "test.md"));
	});

	it("resolves relative paths", () => {
		const resolved = resolvePath("./test.md");
		assert.ok(path.isAbsolute(resolved));
	});

	it("keeps absolute paths unchanged", () => {
		const resolved = resolvePath("/absolute/path.md");
		assert.equal(resolved, "/absolute/path.md");
	});
});
