import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../../src/fleet/fleet-manager.js";
import { ProfileStore } from "../../src/fleet/profile-store.js";
import type { BotProfile } from "../../src/fleet/types.js";

// Allow alpine images for e2e tests (real Docker pulls)
vi.stubEnv("FLEET_IMAGE_ALLOWLIST", "ghcr.io/wopr-network/,alpine:");

// ---------------------------------------------------------------------------
// Docker availability check — skip entire suite when Docker is not reachable
// ---------------------------------------------------------------------------

let dockerAvailable = false;
try {
  const probe = new Docker();
  await Promise.race([
    probe.ping(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
  ]);
  dockerAvailable = true;
} catch {
  // Docker not available or unreachable
}

/** Unique prefix so we never collide with real containers */
const TEST_PREFIX = `wopr-e2e-${Date.now()}`;

/** Lightweight image that exits immediately — fast to pull, tiny footprint */
const TEST_IMAGE = "alpine:3.21";

/** A second image tag for update tests */
const TEST_IMAGE_ALT = "alpine:3.20";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** List all containers whose name starts with our test prefix */
async function listTestContainers(docker: Docker): Promise<Docker.ContainerInfo[]> {
  const all = await docker.listContainers({ all: true });
  return all.filter((c) => c.Names.some((n) => n.startsWith(`/${TEST_PREFIX}`) || n.startsWith(`/wopr-${TEST_PREFIX}`)));
}

/** Forcefully remove every test container (cleanup) */
async function removeAllTestContainers(docker: Docker): Promise<void> {
  const containers = await listTestContainers(docker);
  for (const info of containers) {
    const c = docker.getContainer(info.Id);
    try {
      await c.stop().catch(() => {});
      await c.remove({ v: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/** Also clean up any containers created via FleetManager (labeled wopr.managed) */
async function removeAllWoprTestContainers(docker: Docker): Promise<void> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ["wopr.managed=true"] },
  });
  for (const info of containers) {
    // Only remove containers whose names match our test prefix
    const isOurs = info.Names.some(
      (n) => n.includes(TEST_PREFIX),
    );
    if (!isOurs) continue;
    const c = docker.getContainer(info.Id);
    try {
      await c.stop().catch(() => {});
      await c.remove({ v: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function profileParams(name: string): Omit<BotProfile, "id"> {
  return {
    name: `${TEST_PREFIX}-${name}`,
    description: "E2E test bot",
    image: TEST_IMAGE,
    env: {},
    restartPolicy: "no",
    releaseChannel: "stable",
    updatePolicy: "manual",
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)("E2E: Docker container lifecycle", () => {
  let docker: Docker;
  let store: ProfileStore;
  let fleet: FleetManager;
  let tmpDir: string;

  beforeAll(async () => {
    docker = new Docker();

    // Pre-pull test images so individual tests are fast
    for (const img of [TEST_IMAGE, TEST_IMAGE_ALT]) {
      const stream = await docker.pull(img);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wopr-e2e-"));
    store = new ProfileStore(tmpDir);
    await store.init();
    fleet = new FleetManager(docker, store);
  });

  afterEach(async () => {
    await removeAllWoprTestContainers(docker);
    await removeAllTestContainers(docker);
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    // Final sweep in case a test crashed before cleanup
    const d = new Docker();
    await removeAllWoprTestContainers(d);
    await removeAllTestContainers(d);
  });

  // -----------------------------------------------------------------------
  // 1. Create bot instance -> verify container exists
  // -----------------------------------------------------------------------

  describe("create", () => {
    it("creates a container with correct labels", async () => {
      const profile = await fleet.create(profileParams("create-basic"));

      expect(profile.id).toBeDefined();
      expect(profile.name).toBe(`${TEST_PREFIX}-create-basic`);

      // Container should exist (created state — image exits immediately with 'no' restart)
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${profile.id}`] },
      });
      expect(containers.length).toBe(1);
      expect(containers[0].Labels["wopr.managed"]).toBe("true");
      expect(containers[0].Labels["wopr.bot-id"]).toBe(profile.id);
    });

    it("can start the created container", async () => {
      const profile = await fleet.create(profileParams("create-start"));

      await fleet.start(profile.id);

      const status = await fleet.status(profile.id);
      // Alpine with no CMD will exit quickly, but it should at least get to
      // a "running" or "exited" state after start
      expect(["running", "exited"]).toContain(status.state);
      expect(status.containerId).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Health check -> verify container health reporting
  // -----------------------------------------------------------------------

  describe("health check", () => {
    it("reports health status from container inspect", async () => {
      const profile = await fleet.create(profileParams("health"));

      // The FleetManager creates containers with a HEALTHCHECK.
      // We can at least verify the status call works.
      const status = await fleet.status(profile.id);
      expect(status.id).toBe(profile.id);
      // Container with alpine + no CMD might already have exited, but
      // health field should exist or be null
      expect(status).toHaveProperty("health");
    });
  });

  // -----------------------------------------------------------------------
  // 3. Update image -> verify new container, old stopped
  // -----------------------------------------------------------------------

  describe("update image", () => {
    it("recreates container with new image on update", async () => {
      const profile = await fleet.create(profileParams("update-img"));

      // Record original container ID
      const beforeContainers = await docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${profile.id}`] },
      });
      expect(beforeContainers).toHaveLength(1);
      const oldContainerId = beforeContainers[0].Id;

      // Update to a different image tag
      const updated = await fleet.update(profile.id, { image: TEST_IMAGE_ALT });
      expect(updated.image).toBe(TEST_IMAGE_ALT);

      // A new container should have been created
      const afterContainers = await docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${profile.id}`] },
      });
      expect(afterContainers.length).toBe(1);

      // Old container should be gone (removed by FleetManager.update)
      const oldStillExists = await docker
        .getContainer(oldContainerId)
        .inspect()
        .then(() => true)
        .catch(() => false);
      expect(oldStillExists).toBe(false);
    });

    it("preserves profile data through update", async () => {
      const params = profileParams("update-preserve");
      params.env = { MY_VAR: "hello" };
      const profile = await fleet.create(params);

      await fleet.update(profile.id, { image: TEST_IMAGE_ALT });

      // Profile should retain non-updated fields
      const stored = await store.get(profile.id);
      expect(stored).not.toBeNull();
      expect(stored!.name).toBe(params.name);
      expect(stored!.env).toEqual({ MY_VAR: "hello" });
      expect(stored!.image).toBe(TEST_IMAGE_ALT);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Profile rollback on create failure
  // -----------------------------------------------------------------------

  describe("rollback on create failure", () => {
    it("rolls back profile when container creation fails with bad image", async () => {
      const params = profileParams("rollback-create");
      params.image = "invalid-registry.example.com/does-not-exist:never";

      await expect(fleet.create(params)).rejects.toThrow();

      // Profile should have been cleaned up
      const profiles = await store.list();
      const found = profiles.find((p) => p.name === params.name);
      expect(found).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 5. Destroy -> verify container removed, volumes cleaned
  // -----------------------------------------------------------------------

  describe("destroy", () => {
    it("removes container and deletes profile", async () => {
      const profile = await fleet.create(profileParams("destroy-basic"));

      await fleet.remove(profile.id, true);

      // Container should be gone
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${profile.id}`] },
      });
      expect(containers.length).toBe(0);

      // Profile should be deleted
      const stored = await store.get(profile.id);
      expect(stored).toBeNull();
    });

    it("handles removing a started-then-stopped container", async () => {
      const profile = await fleet.create(profileParams("destroy-stopped"));

      // Start then stop
      await fleet.start(profile.id);
      // Wait briefly for container to start
      await new Promise((r) => setTimeout(r, 500));
      await fleet.stop(profile.id).catch(() => {
        // Container may have already exited (alpine with no CMD)
      });

      await fleet.remove(profile.id, true);

      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${profile.id}`] },
      });
      expect(containers.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Concurrent instance creation
  // -----------------------------------------------------------------------

  describe("concurrent creation", () => {
    it("creates multiple bot instances in parallel", async () => {
      const names = ["concurrent-a", "concurrent-b", "concurrent-c"];
      const results = await Promise.all(names.map((n) => fleet.create(profileParams(n))));

      expect(results).toHaveLength(3);

      // Each should have a unique ID and container
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(3);

      // Verify all containers exist
      for (const profile of results) {
        const containers = await docker.listContainers({
          all: true,
          filters: { label: [`wopr.bot-id=${profile.id}`] },
        });
        expect(containers.length).toBe(1);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 7. Resource limits enforcement
  // -----------------------------------------------------------------------

  describe("resource limits", () => {
    it("applies memory and CPU limits to container", async () => {
      const limits = {
        Memory: 64 * 1024 * 1024, // 64 MB
        CpuQuota: 50_000, // 50% of one CPU (period=100000)
        PidsLimit: 100,
      };

      const profile = await fleet.create(profileParams("resource-limits"), limits);

      // Inspect the container to verify resource limits
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${profile.id}`] },
      });
      expect(containers.length).toBe(1);

      const container = docker.getContainer(containers[0].Id);
      const info = await container.inspect();

      expect(info.HostConfig.Memory).toBe(64 * 1024 * 1024);
      expect(info.HostConfig.CpuQuota).toBe(50_000);
      expect(info.HostConfig.PidsLimit).toBe(100);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Full lifecycle: create -> start -> update -> destroy
  // -----------------------------------------------------------------------

  describe("full lifecycle", () => {
    it("handles create -> start -> status -> update -> remove", async () => {
      // Create
      const profile = await fleet.create(profileParams("lifecycle"));
      expect(profile.id).toBeDefined();

      // Start
      await fleet.start(profile.id);

      // Status
      const status1 = await fleet.status(profile.id);
      expect(status1.containerId).toBeTruthy();

      // Update image
      const updated = await fleet.update(profile.id, { image: TEST_IMAGE_ALT });
      expect(updated.image).toBe(TEST_IMAGE_ALT);

      // Status after update — should reflect new container
      const status2 = await fleet.status(profile.id);
      expect(status2.image).toBe(TEST_IMAGE_ALT);

      // Remove
      await fleet.remove(profile.id, true);

      // Verify fully cleaned up
      const containers = await docker.listContainers({
        all: true,
        filters: { label: [`wopr.bot-id=${profile.id}`] },
      });
      expect(containers.length).toBe(0);
      expect(await store.get(profile.id)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 9. listAll with real containers
  // -----------------------------------------------------------------------

  describe("listAll", () => {
    it("returns status for all bots with real container state", async () => {
      await fleet.create(profileParams("list-a"));
      await fleet.create(profileParams("list-b"));

      const all = await fleet.listAll();
      expect(all.length).toBe(2);

      for (const status of all) {
        expect(status.containerId).toBeTruthy();
        expect(status.id).toBeDefined();
      }
    });
  });
});
