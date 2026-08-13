#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type PrimeBridgeConfig, resolveBridgeConfig } from "./config";
import { PrimeDaemonClient } from "./prime/client";
import { type PrimeBridgeLogger, type PrimeBridgeServer, startPrimeBridgeServer } from "./server";
import { runSessionCommand, type SessionConvertDependencies } from "./session/convert";
import { BridgeStore } from "./store";

const PRIME_SKILL_MARKER = ".omp-managed";
const PRIME_SKILL_MARKER_CONTENT = "omp-prime-bridge-skill-v1\n";
const PRIME_MESSAGE_SKILL_DIRECTORY = "omp-message";
const PRIME_TOOLS_SKILL_DIRECTORY = "omp-tools";
export interface PrimeBridgeCliDependencies {
	config?: PrimeBridgeConfig;
	store?: BridgeStore;
	primeClient?: PrimeDaemonClient;
	logger?: PrimeBridgeLogger;
	peers?: () => unknown | Promise<unknown>;
	startServer?: typeof startPrimeBridgeServer;
	installPrimeSkill?: typeof installPrimeSkill;
	session?: SessionConvertDependencies;
}

export interface RunningPrimeBridge {
	readonly url: string;
	stop(): Promise<void>;
}

function optionValue(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
	return value;
}

function parsePort(argv: readonly string[]): number | undefined {
	const raw = optionValue(argv, "--port");
	if (raw === undefined) return undefined;
	const port = Number(raw);
	if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
		throw new Error("--port must be an integer between 0 and 65535");
	return port;
}

export interface PrimeSkillInstallOptions {
	homeDir?: string;
	sourceDir?: string;
	toolsSourceDir?: string;
}

function isNotFound(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return error.code === "ENOENT";
}

async function assertDirectory(directory: string, create: boolean): Promise<void> {
	try {
		const stat = await fs.lstat(directory);
		if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked Prime skill path: ${directory}`);
		if (!stat.isDirectory()) throw new Error(`Prime skill path is not a directory: ${directory}`);
	} catch (error) {
		if (!create || !isNotFound(error)) throw error;
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	}
	await fs.chmod(directory, 0o700);
}

async function copySkillTree(source: string, destination: string): Promise<void> {
	const sourceStat = await fs.lstat(source);
	if (sourceStat.isSymbolicLink()) throw new Error(`Refusing symlinked bundled Prime skill: ${source}`);
	if (!sourceStat.isDirectory()) throw new Error(`Bundled Prime skill is not a directory: ${source}`);
	await fs.mkdir(destination, { mode: 0o700 });
	for (const entry of await fs.readdir(source, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) throw new Error(`Refusing symlinked bundled Prime skill entry: ${entry.name}`);
		const sourceEntry = path.join(source, entry.name);
		const destinationEntry = path.join(destination, entry.name);
		if (entry.isDirectory()) {
			await copySkillTree(sourceEntry, destinationEntry);
			continue;
		}
		if (!entry.isFile()) throw new Error(`Unsupported bundled Prime skill entry: ${entry.name}`);
		await fs.copyFile(sourceEntry, destinationEntry);
		await fs.chmod(destinationEntry, 0o600);
	}
}

async function isManagedSkill(directory: string): Promise<boolean> {
	const marker = path.join(directory, PRIME_SKILL_MARKER);
	try {
		const stat = await fs.lstat(marker);
		if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked Prime skill marker: ${marker}`);
		if (!stat.isFile()) return false;
		return (await fs.readFile(marker, "utf8")) === PRIME_SKILL_MARKER_CONTENT;
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

async function installManagedPrimeSkill(skillsDir: string, sourceDir: string, skillDirectory: string): Promise<string> {
	const targetDir = path.join(skillsDir, skillDirectory);

	let targetExists = false;
	try {
		const targetStat = await fs.lstat(targetDir);
		targetExists = true;
		if (targetStat.isSymbolicLink()) throw new Error(`Refusing symlinked Prime skill path: ${targetDir}`);
		if (!targetStat.isDirectory()) return targetDir;
		if (!(await isManagedSkill(targetDir))) return targetDir;
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
	const stagingDir = path.join(skillsDir, `.${skillDirectory}.tmp-${process.pid}-${randomUUID()}`);
	try {
		await copySkillTree(sourceDir, stagingDir);
		const marker = path.join(stagingDir, PRIME_SKILL_MARKER);
		await fs.writeFile(marker, PRIME_SKILL_MARKER_CONTENT, { mode: 0o600 });
		await fs.chmod(stagingDir, 0o700);
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		throw error;
	}

	let backupDir: string | undefined;
	try {
		if (!targetExists) {
			await fs.rename(stagingDir, targetDir);
		} else {
			const candidateBackupDir = path.join(skillsDir, `.${skillDirectory}.old-${process.pid}-${randomUUID()}`);
			await fs.rename(targetDir, candidateBackupDir);
			backupDir = candidateBackupDir;
			try {
				await fs.rename(stagingDir, targetDir);
			} catch (error) {
				await fs.rename(candidateBackupDir, targetDir);
				backupDir = undefined;
				throw error;
			}
			await fs.rm(candidateBackupDir, { recursive: true, force: true });
			backupDir = undefined;
		}
	} catch (error) {
		await fs.rm(stagingDir, { recursive: true, force: true });
		if (backupDir !== undefined) {
			await fs.rm(targetDir, { recursive: true, force: true });
			await fs.rename(backupDir, targetDir);
		}
		throw error;
	}
	return targetDir;
}

/**
 * Installs both bundled Prime bridge skills without following or replacing
 * user-owned symlinks. Existing unmanaged skills are left untouched.
 */
export async function installPrimeSkill(options: PrimeSkillInstallOptions = {}): Promise<string> {
	const homeDir = options.homeDir ?? os.homedir();
	const messageSourceDir = options.sourceDir ?? path.resolve(import.meta.dir, "..", "prime-skill");
	const toolsSourceDir = options.toolsSourceDir ?? path.resolve(import.meta.dir, "..", "prime-skill-tools");
	const agentsDir = path.join(homeDir, ".agents");
	const skillsDir = path.join(agentsDir, "skills");
	await assertDirectory(agentsDir, true);
	await assertDirectory(skillsDir, true);
	const messageTargetDir = await installManagedPrimeSkill(skillsDir, messageSourceDir, PRIME_MESSAGE_SKILL_DIRECTORY);
	await installManagedPrimeSkill(skillsDir, toolsSourceDir, PRIME_TOOLS_SKILL_DIRECTORY);
	return messageTargetDir;
}

export async function main(
	argv: readonly string[] = Bun.argv.slice(2),
	dependencies: PrimeBridgeCliDependencies = {},
): Promise<RunningPrimeBridge> {
	const config =
		dependencies.config ??
		resolveBridgeConfig({
			stateDir: optionValue(argv, "--state-dir"),
			tokenFile: optionValue(argv, "--token-file"),
			primeConfigFile: optionValue(argv, "--prime-config-file"),
			port: parsePort(argv),
		});
	await (dependencies.installPrimeSkill ?? installPrimeSkill)();
	await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
	await fs.chmod(config.stateDir, 0o700);
	const store = dependencies.store ?? BridgeStore.open(config.databasePath);
	const ownsStore = dependencies.store === undefined;
	let primeClient: PrimeDaemonClient;
	try {
		primeClient = dependencies.primeClient ?? new PrimeDaemonClient({ store });
	} catch (error) {
		if (ownsStore) store.close();
		throw error;
	}
	const ownsPrimeClient = dependencies.primeClient === undefined;
	let bridge: PrimeBridgeServer;
	try {
		bridge = await (dependencies.startServer ?? startPrimeBridgeServer)({
			config,
			store,
			primeClient,
			peers: dependencies.peers,
			logger: dependencies.logger,
		});
	} catch (error) {
		if (ownsPrimeClient) primeClient.close();
		if (ownsStore) store.close();
		throw error;
	}

	let stopPromise: Promise<void> | undefined;
	return {
		url: bridge.url,
		stop(): Promise<void> {
			if (stopPromise !== undefined) return stopPromise;
			stopPromise = (async () => {
				try {
					await bridge.stop();
				} finally {
					if (ownsPrimeClient) primeClient.close();
					if (ownsStore) store.close();
				}
			})();
			return stopPromise;
		},
	};
}

if (import.meta.main) {
	const commandArgs = Bun.argv.slice(2);
	if (commandArgs[0] === "session") {
		try {
			await runSessionCommand(commandArgs, {
				writeOut: (text: string) => console.log(text),
				writeErr: (text: string) => console.error(text),
			});
		} catch (error) {
			console.error("Prime bridge session command failed:", error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	} else {
		let running: RunningPrimeBridge | undefined;
		let stopping: Promise<void> | undefined;
		const shutdown = async (): Promise<void> => {
			if (stopping !== undefined) return stopping;
			if (running === undefined) return;
			stopping = running.stop();
			try {
				await stopping;
			} catch (error) {
				console.error("Prime bridge shutdown failed:", error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			}
		};

		try {
			running = await main();
			console.log(running.url);
			process.once("SIGINT", () => {
				void shutdown();
			});
			process.once("SIGTERM", () => {
				void shutdown();
			});
		} catch (error) {
			console.error("Prime bridge startup failed:", error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}
