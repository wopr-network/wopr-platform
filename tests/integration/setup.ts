/**
 * Shared setup for integration tests.
 *
 * Provides a fully-composed Hono app with mocked external dependencies
 * (Docker, Stripe, filesystem) but real middleware chains and routing.
 */
import BetterSqlite3 from "better-sqlite3";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Environment stubs (MUST be set before any route module is imported)
// ---------------------------------------------------------------------------

export const TEST_TOKEN = "integration-test-token";
export const TEST_PLATFORM_SECRET = "test-platform-secret-32bytes!!ok";
export const TENANT_A_TOKEN = "wopr_write_tenantA123";
export const TENANT_B_TOKEN = "wopr_write_tenantB456";

vi.stubEnv("FLEET_API_TOKEN", TEST_TOKEN);
vi.stubEnv("PLATFORM_SECRET", TEST_PLATFORM_SECRET);
vi.stubEnv("INSTANCE_DATA_DIR", "/tmp/wopr-int-test-instances");
vi.stubEnv("SNAPSHOT_DB_PATH", ":memory:");
vi.stubEnv("SNAPSHOT_DIR", "/tmp/wopr-int-test-snapshots");
vi.stubEnv("WOPR_HOME_BASE", "/tmp/wopr-int-test-instances");
vi.stubEnv("FLEET_TOKEN_TENANT_A", `write:${TENANT_A_TOKEN}`);
vi.stubEnv("FLEET_TOKEN_TENANT_B", `write:${TENANT_B_TOKEN}`);

export const AUTH_HEADER = { Authorization: `Bearer ${TEST_TOKEN}` };
export const JSON_HEADERS = { "Content-Type": "application/json", ...AUTH_HEADER };

// ---------------------------------------------------------------------------
// Module mocks (external dependencies)
// ---------------------------------------------------------------------------

// Fleet / Docker mocks
export const fleetMock = {
  create: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  remove: vi.fn(),
  status: vi.fn(),
  listAll: vi.fn(),
  logs: vi.fn(),
  update: vi.fn(),
  profiles: {
    get: vi.fn(),
    list: vi.fn(),
  },
};

export const updaterMock = {
  updateBot: vi.fn(),
};

export const pollerMock = {
  getImageStatus: vi.fn(),
  onUpdateAvailable: null as ((botId: string) => Promise<void>) | null,
};

vi.mock("dockerode", () => ({
  default: class MockDocker {},
}));

vi.mock("../../src/fleet/profile-store.js", () => ({
  ProfileStore: class MockProfileStore {},
}));

vi.mock("../../src/fleet/fleet-manager.js", () => {
  class BotNotFoundError extends Error {
    constructor(id: string) {
      super(`Bot not found: ${id}`);
      this.name = "BotNotFoundError";
    }
  }
  return {
    FleetManager: class {
      create = fleetMock.create;
      start = fleetMock.start;
      stop = fleetMock.stop;
      restart = fleetMock.restart;
      remove = fleetMock.remove;
      status = fleetMock.status;
      listAll = fleetMock.listAll;
      logs = fleetMock.logs;
      update = fleetMock.update;
      profiles = fleetMock.profiles;
    },
    BotNotFoundError,
  };
});

vi.mock("../../src/fleet/image-poller.js", () => ({
  ImagePoller: class {
    getImageStatus = pollerMock.getImageStatus;
    onUpdateAvailable = pollerMock.onUpdateAvailable;
  },
}));

vi.mock("../../src/fleet/updater.js", () => ({
  ContainerUpdater: class {
    updateBot = updaterMock.updateBot;
  },
}));

vi.mock("../../src/network/network-policy.js", () => ({
  NetworkPolicy: class {
    prepareForContainer = vi.fn().mockResolvedValue("wopr-tenant-mock");
    cleanupAfterRemoval = vi.fn().mockResolvedValue(undefined);
  },
}));

// Friends proxy mock
export const mockProxyToInstance = vi.fn();

vi.mock("../../src/api/routes/friends-proxy.js", () => ({
  proxyToInstance: (...args: unknown[]) => mockProxyToInstance(...args),
}));

// Key injection mock
export const mockWriteEncryptedSeed = vi.fn();
export const mockForwardSecretsToInstance = vi.fn();

vi.mock("../../src/security/key-injection.js", () => ({
  writeEncryptedSeed: (...args: unknown[]) => mockWriteEncryptedSeed(...args),
  forwardSecretsToInstance: (...args: unknown[]) => mockForwardSecretsToInstance(...args),
}));

// Key validation mock
export const mockValidateProviderKey = vi.fn();

vi.mock("../../src/security/key-validation.js", () => ({
  validateProviderKey: (...args: unknown[]) => mockValidateProviderKey(...args),
}));

// Snapshot mocks
export const snapshotManagerMock = {
  create: vi.fn(),
  restore: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
  getOldest: vi.fn(),
};

vi.mock("../../src/backup/snapshot-manager.js", () => {
  class SnapshotNotFoundError extends Error {
    constructor(id: string) {
      super(`Snapshot not found: ${id}`);
      this.name = "SnapshotNotFoundError";
    }
  }
  return {
    SnapshotManager: class {
      create = snapshotManagerMock.create;
      restore = snapshotManagerMock.restore;
      get = snapshotManagerMock.get;
      list = snapshotManagerMock.list;
      delete = snapshotManagerMock.delete;
      count = snapshotManagerMock.count;
      getOldest = snapshotManagerMock.getOldest;
    },
    SnapshotNotFoundError,
  };
});

vi.mock("../../src/backup/retention.js", () => ({
  enforceRetention: vi.fn().mockResolvedValue(0),
}));

// ---------------------------------------------------------------------------
// Database helper
// ---------------------------------------------------------------------------

export function createTestDb(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  db.pragma("journal_mode = WAL");
  return db;
}
