import { describe, expect, it } from "bun:test";
import { renderFormula } from "./ci-update-brew-formula";

const SUMS = {
	"omp-darwin-arm64": "darwin_arm64_sha",
	"omp-darwin-x64": "darwin_x64_sha",
	"omp-linux-arm64": "linux_arm64_sha",
	"omp-linux-x64": "linux_x64_sha",
	"omp-stt-nemotron-darwin-arm64": "stt_worker_sha",
};

describe("renderFormula", () => {
	const formula = renderFormula("15.12.1", SUMS);

	// Regression: bare-binary URLs must opt out of Homebrew's UnpackStrategy.
	// Without `using: :nounzip` the default CurlDownloadStrategy nests the file
	// outside the staging CWD, `Dir["omp-*"].first` returns `nil`, and
	// `bin.install nil => "omp"` raises (issue #2398).
	it("attaches `using: :nounzip` to every per-platform url stanza", () => {
		const matches = formula.match(/using: :nounzip/g) ?? [];
		expect(matches).toHaveLength(5);
		for (const arch of [
			"omp-darwin-arm64",
			"omp-darwin-x64",
			"omp-linux-arm64",
			"omp-linux-x64",
			"omp-stt-nemotron-darwin-arm64",
		]) {
			expect(formula).toMatch(
				new RegExp(
					`url "https://github\\.com/[^"]+/${arch}",\\s+using: :nounzip\\s+sha256 "${SUMS[arch as keyof typeof SUMS]}"`,
				),
			);
		}
	});

	// Regression: completions generation must run with HOME redirected so the
	// popened binary doesn't touch the real `~/.omp` (denied by Homebrew's
	// sandbox profile) during the build (issue #2398).
	it("wraps `generate_completions_from_executable` with a HOME redirect to buildpath", () => {
		expect(formula).toMatch(
			/with_env\(HOME: buildpath\) do\n\s+generate_completions_from_executable\(bin\/"omp", "completions", shells: \[:bash, :zsh, :fish\]\)\n\s+end/,
		);
		// And the bare form (which is what failed in the sandbox) must not appear
		// outside the `with_env` block.
		const blockless = formula.replace(/with_env\(HOME: buildpath\) do[\s\S]*?end/, "");
		expect(blockless).not.toMatch(/generate_completions_from_executable/);
	});

	it("emits the expected per-asset sha256 next to each url", () => {
		for (const name in SUMS) {
			const sha = SUMS[name as keyof typeof SUMS];
			expect(formula).toContain(`/${name}",`);
			expect(formula).toContain(`sha256 "${sha}"`);
		}
	});

	// Regression: the darwin-arm64 release ships the stt-nemotron worker as its
	// own bare-binary asset and the installed omp resolves it only beside its
	// executable — a formula that installs omp without the worker ships broken
	// native dictation on every Apple Silicon brew install.
	it("installs the stt-nemotron worker beside omp on Apple Silicon only", () => {
		expect(formula).toMatch(
			/resource "stt_nemotron" do\n\s+url "https:\/\/github\.com\/[^"]+\/omp-stt-nemotron-darwin-arm64",\n\s+using: :nounzip\n\s+sha256 "stt_worker_sha"\n\s+end/,
		);
		expect(formula).toMatch(
			/if OS\.mac\? && Hardware::CPU\.arm\?\n\s+resource\("stt_nemotron"\)\.stage do\n\s+bin\.install Dir\["omp-stt-nemotron-\*"\]\.first => "stt-nemotron"\n\s+end\n\s+\(bin\/"stt-nemotron"\)\.chmod 0555\n\s+end/,
		);

		// The worker exists only for darwin-arm64: x86-64 macOS and every Linux
		// block must not reference it.
		const onIntel = formula.slice(formula.indexOf("on_intel do"), formula.indexOf("on_linux do"));
		expect(onIntel).not.toContain("stt-nemotron");
		const onLinux = formula.slice(formula.indexOf("on_linux do"), formula.indexOf("def install"));
		expect(onLinux).not.toContain("stt-nemotron");
	});
});
