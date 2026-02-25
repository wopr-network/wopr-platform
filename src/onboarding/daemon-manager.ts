import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../config/logger.js";
import type { OnboardingConfig } from "./config.js";
import type { WoprClient } from "./wopr-client.js";

export interface IDaemonManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
}

const HEALTH_CHECK_INTERVAL_MS = 1000;
const HEALTH_CHECK_MAX_ATTEMPTS = 30;

export class DaemonManager implements IDaemonManager {
  private process: ChildProcess | null = null;
  private ready = false;

  constructor(
    private readonly config: OnboardingConfig,
    private readonly client: WoprClient,
  ) {}

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    logger.info("[onboarding] starting WOPR daemon", {
      port: this.config.woprPort,
      dataDir: this.config.woprDataDir,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WOPR_HOME: this.config.woprDataDir,
      WOPR_PORT: String(this.config.woprPort),
      WOPR_LLM_PROVIDER: this.config.llmProvider,
      WOPR_LLM_MODEL: this.config.llmModel,
    };

    const woprBin = this.resolveWoprBin();
    this.process = spawn(woprBin, ["daemon", "start", "--foreground"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      logger.debug(`[onboarding-wopr] ${data.toString().trim()}`);
    });
    this.process.stderr?.on("data", (data: Buffer) => {
      logger.warn(`[onboarding-wopr] ${data.toString().trim()}`);
    });
    this.process.on("exit", (code) => {
      logger.warn("[onboarding] WOPR daemon exited", { code });
      this.process = null;
      this.ready = false;
    });

    await this.waitForReady();

    // Read auth token written by daemon
    try {
      const tokenPath = join(this.config.woprDataDir, "auth-token");
      const token = readFileSync(tokenPath, "utf8").trim();
      this.client.setAuthToken(token);
    } catch {
      logger.warn("[onboarding] could not read WOPR auth token; daemon may not require auth");
    }

    this.ready = true;
    logger.info("[onboarding] WOPR daemon ready", { port: this.config.woprPort });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }
    logger.info("[onboarding] stopping WOPR daemon");
    this.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const p = this.process;
      if (!p) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        p.kill("SIGKILL");
        resolve();
      }, 5000);
      p.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.process = null;
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  private async waitForReady(): Promise<void> {
    for (let i = 0; i < HEALTH_CHECK_MAX_ATTEMPTS; i++) {
      const ok = await this.client.healthCheck();
      if (ok) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }
    throw new Error(`[onboarding] WOPR daemon did not become healthy after ${HEALTH_CHECK_MAX_ATTEMPTS}s`);
  }

  private resolveWoprBin(): string {
    // Try npx wopr, then fall back to the binary on PATH
    return process.env.WOPR_BIN ?? "wopr";
  }
}
