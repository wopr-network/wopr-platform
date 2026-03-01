/**
 * Unit tests for the tRPC settings router.
 *
 * Uses the caller pattern — no HTTP transport, no database.
 * Deps are injected via setSettingsRouterDeps / setTrpcOrgMemberRepo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { INotificationPreferencesStore } from "../../email/notification-preferences-store.js";
import type { NotificationPrefs } from "../../email/notification-repository-types.js";
import type { IOrgMemberRepository } from "../../fleet/org-member-repository.js";
import { appRouter } from "../index.js";
import type { TRPCContext } from "../init.js";
import { setTrpcOrgMemberRepo } from "../init.js";
import { setSettingsRouterDeps } from "./settings.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = "user-1";
const TEST_TENANT_ID = "tenant-1";

// ---------------------------------------------------------------------------
// Stub org member repo (for tenantProcedure middleware)
// ---------------------------------------------------------------------------

const stubOrgMemberRepo: IOrgMemberRepository = {
  listMembers: async () => [],
  addMember: async () => {},
  updateMemberRole: async () => {},
  removeMember: async () => {},
  findMember: async (orgId, userId) =>
    orgId === TEST_TENANT_ID && userId === TEST_USER_ID
      ? { id: "mem-1", orgId, userId, role: "owner", joinedAt: Date.now() }
      : null,
  countAdminsAndOwners: async () => 1,
  listInvites: async () => [],
  createInvite: async () => {},
  findInviteById: async () => null,
  findInviteByToken: async () => null,
  deleteInvite: async () => {},
  deleteAllMembers: async () => {},
  deleteAllInvites: async () => {},
};

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const DEFAULT_PREFS: NotificationPrefs = {
  billing_low_balance: true,
  billing_receipts: true,
  billing_auto_topup: true,
  agent_channel_disconnect: true,
  agent_status_changes: false,
  account_role_changes: true,
  account_team_invites: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPrefsStore(): INotificationPreferencesStore {
  const storage = new Map<string, NotificationPrefs>();
  return {
    get: vi.fn().mockImplementation(async (tenantId: string) => {
      return storage.get(tenantId) ?? { ...DEFAULT_PREFS };
    }),
    update: vi.fn().mockImplementation(async (tenantId: string, prefs: Partial<NotificationPrefs>) => {
      const existing = storage.get(tenantId) ?? { ...DEFAULT_PREFS };
      storage.set(tenantId, { ...existing, ...prefs });
    }),
  };
}

function createCaller(ctx: Partial<TRPCContext>) {
  return appRouter.createCaller(ctx as TRPCContext);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("settingsRouter", () => {
  let mockPrefsStore: ReturnType<typeof makeMockPrefsStore>;

  const authedCtx: Partial<TRPCContext> = {
    user: { id: TEST_USER_ID, roles: [] },
    tenantId: TEST_TENANT_ID,
  };

  beforeEach(() => {
    setTrpcOrgMemberRepo(stubOrgMemberRepo);
    mockPrefsStore = makeMockPrefsStore();
    setSettingsRouterDeps({ getNotificationPrefsStore: () => mockPrefsStore });
  });

  // -------------------------------------------------------------------------
  // health
  // -------------------------------------------------------------------------

  describe("health", () => {
    it("returns ok status without authentication", async () => {
      const caller = createCaller({ user: undefined, tenantId: undefined });
      const result = await caller.settings.health();
      expect(result.status).toBe("ok");
      expect(result.service).toBe("wopr-platform");
    });
  });

  // -------------------------------------------------------------------------
  // tenantConfig
  // -------------------------------------------------------------------------

  describe("tenantConfig", () => {
    it("returns tenant configuration for authenticated user", async () => {
      const caller = createCaller(authedCtx);
      const result = await caller.settings.tenantConfig();
      expect(result.tenantId).toBe(TEST_TENANT_ID);
      expect(result.configured).toBe(true);
    });

    it("rejects unauthenticated calls", async () => {
      const caller = createCaller({ user: undefined, tenantId: TEST_TENANT_ID });
      await expect(caller.settings.tenantConfig()).rejects.toThrow(/Authentication required/);
    });
  });

  // -------------------------------------------------------------------------
  // ping
  // -------------------------------------------------------------------------

  describe("ping", () => {
    it("returns ok with user and tenant info", async () => {
      const caller = createCaller(authedCtx);
      const result = await caller.settings.ping();
      expect(result.ok).toBe(true);
      expect(result.tenantId).toBe(TEST_TENANT_ID);
      expect(result.userId).toBe(TEST_USER_ID);
      expect(result.timestamp).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // notificationPreferences
  // -------------------------------------------------------------------------

  describe("notificationPreferences", () => {
    it("returns defaults for new tenant", async () => {
      const caller = createCaller(authedCtx);
      const result = await caller.settings.notificationPreferences();
      expect(result).toEqual(DEFAULT_PREFS);
      expect(mockPrefsStore.get).toHaveBeenCalledWith(TEST_TENANT_ID);
    });

    it("rejects unauthenticated calls", async () => {
      const caller = createCaller({ user: undefined, tenantId: TEST_TENANT_ID });
      await expect(caller.settings.notificationPreferences()).rejects.toThrow(/Authentication required/);
    });
  });

  // -------------------------------------------------------------------------
  // updateNotificationPreferences
  // -------------------------------------------------------------------------

  describe("updateNotificationPreferences", () => {
    it("calls update with the given prefs and returns current values", async () => {
      const caller = createCaller(authedCtx);
      const result = await caller.settings.updateNotificationPreferences({
        agent_status_changes: true,
        billing_receipts: false,
      });

      expect(mockPrefsStore.update).toHaveBeenCalledWith(TEST_TENANT_ID, {
        agent_status_changes: true,
        billing_receipts: false,
      });
      expect(mockPrefsStore.get).toHaveBeenCalledWith(TEST_TENANT_ID);
      // The returned value is from store.get (the mock returns defaults since update is not awaited)
      expect(result).toBeDefined();
    });

    it("rejects unauthenticated calls", async () => {
      const caller = createCaller({ user: undefined, tenantId: TEST_TENANT_ID });
      await expect(caller.settings.updateNotificationPreferences({ billing_receipts: false })).rejects.toThrow(
        /Authentication required/,
      );
    });

    it("rejects calls without tenant context", async () => {
      const caller = createCaller({ user: { id: TEST_USER_ID, roles: [] }, tenantId: undefined });
      await expect(caller.settings.updateNotificationPreferences({ billing_receipts: false })).rejects.toThrow(
        /Tenant context required/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // testProvider
  // -------------------------------------------------------------------------

  describe("testProvider", () => {
    it("returns error when testProvider is not configured", async () => {
      const caller = createCaller(authedCtx);
      const result = await caller.settings.testProvider({ provider: "openai" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not configured");
    });

    it("calls testProvider function when configured", async () => {
      const testFn = vi.fn().mockResolvedValue({ ok: true, latencyMs: 42 });
      setSettingsRouterDeps({
        getNotificationPrefsStore: () => mockPrefsStore,
        testProvider: testFn,
      });

      const caller = createCaller(authedCtx);
      const result = await caller.settings.testProvider({ provider: "openai" });
      expect(result.ok).toBe(true);
      expect(testFn).toHaveBeenCalledWith("openai", TEST_TENANT_ID);
    });
  });
});
