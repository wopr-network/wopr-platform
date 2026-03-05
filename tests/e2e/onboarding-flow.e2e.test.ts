import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../src/test/db.js";
import type { DrizzleDb } from "../../src/db/index.js";
import { CreditLedger } from "../../src/monetization/credits/credit-ledger.js";
import { grantSignupCredits, SIGNUP_GRANT } from "../../src/monetization/credits/signup-grant.js";
import { BotBilling } from "../../src/monetization/credits/bot-billing.js";
import { DrizzleBotInstanceRepository } from "../../src/fleet/drizzle-bot-instance-repository.js";
import { DrizzleOnboardingSessionRepository } from "../../src/onboarding/drizzle-onboarding-session-repository.js";
import { OnboardingService } from "../../src/onboarding/onboarding-service.js";
import { GraduationService } from "../../src/onboarding/graduation-service.js";
import { DrizzleSessionUsageRepository } from "../../src/inference/session-usage-repository.js";
import type { IDaemonManager } from "../../src/onboarding/daemon-manager.js";
import type { IWoprClient, ConversationEntry } from "../../src/onboarding/wopr-client.js";
import type { OnboardingConfig } from "../../src/onboarding/config.js";
import type { BotInstance } from "../../src/fleet/repository-types.js";

function stubDaemon(): IDaemonManager {
  return { start: async () => {}, stop: async () => {}, isReady: () => true };
}

function stubWoprClient(): IWoprClient {
  return {
    createSession: async () => {},
    getSessionHistory: async () => [] as ConversationEntry[],
    inject: async () => "Welcome to WOPR! Let me help you get started.",
    deleteSession: async () => {},
    healthCheck: async () => true,
  };
}

function testConfig(): OnboardingConfig {
  return {
    woprPort: 3847,
    llmProvider: "anthropic",
    llmModel: "test-model",
    woprDataDir: "/tmp/wopr-test",
    enabled: true,
  };
}

describe("E2E: onboarding flow — new user → setup wizard → first bot running", () => {
  let db: DrizzleDb;
  let pool: PGlite;
  let ledger: CreditLedger;
  let botBilling: BotBilling;
  let sessionRepo: DrizzleOnboardingSessionRepository;
  let usageRepo: DrizzleSessionUsageRepository;

  const TENANT_ID = `e2e-onboard-${randomUUID()}`;
  const USER_ID = TENANT_ID; // graduation uses userId as tenantId for bot lookup
  const BOT_ID = `bot-${randomUUID()}`;
  const BOT_NAME = "my-first-bot";

  beforeEach(async () => {
    ({ db, pool } = await createTestDb());
    ledger = new CreditLedger(db);
    botBilling = new BotBilling(new DrizzleBotInstanceRepository(db));
    sessionRepo = new DrizzleOnboardingSessionRepository(db);
    usageRepo = new DrizzleSessionUsageRepository(db);
  });

  afterEach(async () => {
    await pool.close();
  });

  // =========================================================================
  // TEST 1: Signup credits granted to fresh tenant
  // =========================================================================

  it("grants $5.00 signup credits to a fresh tenant", async () => {
    const granted = await grantSignupCredits(ledger, TENANT_ID);
    expect(granted).toBe(true);

    const balance = await ledger.balance(TENANT_ID);
    expect(balance.equals(SIGNUP_GRANT)).toBe(true);
  });

  // =========================================================================
  // TEST 2: Idempotent signup grant
  // =========================================================================

  it("signup grant is idempotent — second call returns false, balance unchanged", async () => {
    expect(await grantSignupCredits(ledger, TENANT_ID)).toBe(true);
    expect(await grantSignupCredits(ledger, TENANT_ID)).toBe(false);
    expect((await ledger.balance(TENANT_ID)).equals(SIGNUP_GRANT)).toBe(true);
  });

  // =========================================================================
  // TEST 3: Onboarding session creation and state
  // =========================================================================

  it("creates an onboarding session and advances through active state", async () => {
    const onboarding = new OnboardingService(
      sessionRepo,
      stubWoprClient(),
      testConfig(),
      stubDaemon(),
    );

    const session = await onboarding.createSession({ userId: USER_ID });
    expect(session.status).toBe("active");
    expect(session.userId).toBe(USER_ID);
    expect(session.woprSessionName).toMatch(/^onboarding-/);
    expect(session.graduatedAt).toBeNull();

    // Retrieve same session — idempotent
    const same = await onboarding.createSession({ userId: USER_ID });
    expect(same.id).toBe(session.id);
  });

  // =========================================================================
  // TEST 4: Bot registration — billing state active
  // =========================================================================

  it("registers a bot in active billing state", async () => {
    await botBilling.registerBot(BOT_ID, TENANT_ID, BOT_NAME);

    const bot = (await botBilling.getBotBilling(BOT_ID)) as BotInstance | null;
    expect(bot).not.toBeNull();
    expect(bot!.billingState).toBe("active");
    expect(bot!.tenantId).toBe(TENANT_ID);
    expect(await botBilling.getActiveBotCount(TENANT_ID)).toBe(1);
  });

  // =========================================================================
  // TEST 5: Graduation — session moves to graduated
  // =========================================================================

  it("graduates onboarding session after bot exists", async () => {
    // Register bot first (graduation requires it)
    await botBilling.registerBot(BOT_ID, USER_ID, BOT_NAME);

    // Create onboarding session
    const onboarding = new OnboardingService(
      sessionRepo,
      stubWoprClient(),
      testConfig(),
      stubDaemon(),
    );
    const session = await onboarding.createSession({ userId: USER_ID });

    // Graduate
    const gradService = new GraduationService(
      sessionRepo,
      new DrizzleBotInstanceRepository(db),
      usageRepo,
    );
    const result = await gradService.graduate(session.id, "hosted");

    expect(result.graduated).toBe(true);
    expect(result.path).toBe("hosted");
    expect(result.botInstanceId).toBe(BOT_ID);

    // Verify session is now graduated in DB
    const updated = await sessionRepo.getById(session.id);
    expect(updated!.status).toBe("graduated");
    expect(updated!.graduatedAt).not.toBeNull();
    expect(updated!.graduationPath).toBe("hosted");
  });

  // =========================================================================
  // TEST 6: Full picture — credits + onboarding complete + bot active
  // =========================================================================

  it("full onboarding path: credits → session → bot → graduation → all green", async () => {
    // 1. Grant signup credits
    const granted = await grantSignupCredits(ledger, TENANT_ID);
    expect(granted).toBe(true);
    expect((await ledger.balance(TENANT_ID)).equals(SIGNUP_GRANT)).toBe(true);

    // 2. Idempotency check
    expect(await grantSignupCredits(ledger, TENANT_ID)).toBe(false);
    expect((await ledger.balance(TENANT_ID)).equals(SIGNUP_GRANT)).toBe(true);

    // 3. Create onboarding session
    const onboarding = new OnboardingService(
      sessionRepo,
      stubWoprClient(),
      testConfig(),
      stubDaemon(),
    );
    const session = await onboarding.createSession({ userId: USER_ID });
    expect(session.status).toBe("active");

    // 4. Register bot
    await botBilling.registerBot(BOT_ID, USER_ID, BOT_NAME);
    const bot = (await botBilling.getBotBilling(BOT_ID)) as BotInstance | null;
    expect(bot!.billingState).toBe("active");

    // 5. Graduate
    const gradService = new GraduationService(
      sessionRepo,
      new DrizzleBotInstanceRepository(db),
      usageRepo,
    );
    const gradResult = await gradService.graduate(session.id, "hosted");
    expect(gradResult.graduated).toBe(true);

    // 6. Assert full picture
    const finalBalance = await ledger.balance(TENANT_ID);
    expect(finalBalance.equals(SIGNUP_GRANT)).toBe(true); // no debits yet

    const finalSession = await sessionRepo.getById(session.id);
    expect(finalSession!.status).toBe("graduated");
    expect(finalSession!.graduatedAt).not.toBeNull();

    const finalBot = (await botBilling.getBotBilling(BOT_ID)) as BotInstance | null;
    expect(finalBot!.billingState).toBe("active");

    // Credits ✓, Onboarding complete ✓, Bot active ✓
  });
});
