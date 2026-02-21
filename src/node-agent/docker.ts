import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import Docker from "dockerode";
import { TENANT_PREFIX } from "./types.js";

/**
 * Thin wrapper around Dockerode that exposes only the operations the node
 * agent needs. Uses the Docker SDK exclusively -- no child_process.exec.
 */
export class DockerManager {
  readonly docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker({ socketPath: "/var/run/docker.sock" });
  }

  /** List all tenant containers (name starts with TENANT_PREFIX). */
  async listTenantContainers(): Promise<Docker.ContainerInfo[]> {
    const all = await this.docker.listContainers({ all: true });
    return all.filter((c) => c.Names.some((n) => n.replace(/^\//, "").startsWith(TENANT_PREFIX)));
  }

  /** Start a new tenant container. */
  async startBot(payload: {
    name: string;
    image: string;
    env?: Record<string, string>;
    restart?: string;
  }): Promise<string> {
    const name = payload.name.startsWith(TENANT_PREFIX) ? payload.name : `${TENANT_PREFIX}${payload.name}`;
    const envArr = payload.env ? Object.entries(payload.env).map(([k, v]) => `${k}=${v}`) : [];

    // Pull image first
    const stream = await this.docker.pull(payload.image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const container = await this.docker.createContainer({
      Image: payload.image,
      name,
      Env: envArr,
      HostConfig: {
        RestartPolicy: { Name: payload.restart ?? "unless-stopped" },
      },
    });

    await container.start();
    return container.id;
  }

  /** Stop a tenant container by name. */
  async stopBot(name: string): Promise<void> {
    const container = this.docker.getContainer(name);
    await container.stop();
  }

  /** Restart a tenant container by name. */
  async restartBot(name: string): Promise<void> {
    const container = this.docker.getContainer(name);
    await container.restart();
  }

  /**
   * Update a bot's environment variables by recreating its container.
   * Docker does not support modifying env on a running container,
   * so we: inspect -> stop -> remove -> create+start with new env.
   */
  async updateBotEnv(name: string, env: Record<string, string>): Promise<string> {
    const container = this.docker.getContainer(name);
    const info = await container.inspect();

    const image = info.Config.Image;
    const restartPolicy = info.HostConfig?.RestartPolicy?.Name ?? "unless-stopped";

    // Stop and remove old container
    try {
      await container.stop();
    } catch (err) {
      // Docker 304: container already stopped — not an error
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("container already stopped")) throw err;
    }
    await container.remove();

    // Recreate with new env
    return this.startBot({ name, image, env, restart: restartPolicy });
  }

  /**
   * Update a running bot's environment by replacing its container.
   * Steps: inspect old -> stop old -> remove old -> create new -> start new.
   * On failure after removal, attempt to recreate the old container.
   * No image pull — uses the image already cached on the node.
   */
  async updateBot(payload: { name: string; env: Record<string, string> }): Promise<{ containerId: string }> {
    const name = payload.name.startsWith(TENANT_PREFIX) ? payload.name : `${TENANT_PREFIX}${payload.name}`;

    const container = this.docker.getContainer(name);

    // Inspect old container to capture image + config for rollback
    const info = await container.inspect();
    const image = info.Config.Image;
    const oldEnv = info.Config.Env ?? [];
    const restartPolicy = info.HostConfig?.RestartPolicy?.Name ?? "unless-stopped";

    // Stop the old container (ignore error if already stopped)
    try {
      await container.stop();
    } catch (err) {
      // Docker 304: container already stopped — not an error
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("container already stopped")) throw err;
    }

    // Remove the old container
    await container.remove();

    // Create new container with updated env
    const envArr = Object.entries(payload.env).map(([k, v]) => `${k}=${v}`);

    try {
      const newContainer = await this.docker.createContainer({
        Image: image,
        name,
        Env: envArr,
        HostConfig: {
          RestartPolicy: { Name: restartPolicy },
        },
      });

      await newContainer.start();
      return { containerId: newContainer.id };
    } catch (err) {
      // Rollback: recreate old container with original env and start it
      try {
        const rollback = await this.docker.createContainer({
          Image: image,
          name,
          Env: oldEnv,
          HostConfig: {
            RestartPolicy: { Name: restartPolicy },
          },
        });
        await rollback.start();
      } catch {
        // Rollback failed — container is gone. Caller handles.
      }
      throw err;
    }
  }

  /** Remove a tenant container by name. */
  async removeBot(name: string): Promise<void> {
    const container = this.docker.getContainer(name);
    try {
      await container.stop();
    } catch (err) {
      // Docker 304: container already stopped — not an error
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("container already stopped")) throw err;
    }
    await container.remove();
  }

  /** Export a container to a tar.gz file in backupDir. Returns the file path. */
  async exportBot(name: string, backupDir: string): Promise<string> {
    const outPath = join(backupDir, `${name}.tar.gz`);
    await mkdir(dirname(outPath), { recursive: true });

    const container = this.docker.getContainer(name);
    const exportStream = await container.export();

    // Dockerode export returns a raw tar stream. We write it directly.
    // For gzip compression we use node:zlib through a transform.
    const { createGzip } = await import("node:zlib");
    const gzip = createGzip();
    const fileStream = createWriteStream(outPath);

    await pipeline(exportStream as unknown as NodeJS.ReadableStream, gzip, fileStream);
    return outPath;
  }

  /** Import a tar.gz and create+start a container from it. */
  async importBot(name: string, backupDir: string, image: string, env?: Record<string, string>): Promise<string> {
    const tarPath = join(backupDir, `${name}.tar.gz`);
    const { createReadStream } = await import("node:fs");
    const { createGunzip } = await import("node:zlib");

    const gunzip = createGunzip();
    const fileStream = createReadStream(tarPath);

    // Import the tar as a new Docker image
    const importStream = await this.docker.importImage(fileStream.pipe(gunzip) as unknown as NodeJS.ReadableStream);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(importStream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Create and start a new container from the imported image
    const containerName = name.startsWith(TENANT_PREFIX) ? name : `${TENANT_PREFIX}${name}`;
    const envArr = env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : [];

    const container = await this.docker.createContainer({
      Image: image,
      name: containerName,
      Env: envArr,
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
      },
    });

    await container.start();
    return container.id;
  }

  /** Get container logs (last N lines). */
  async getLogs(name: string, tail = 100): Promise<string> {
    const container = this.docker.getContainer(name);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });
    return logs.toString("utf-8");
  }

  /** Inspect a container and return its full info. */
  async inspectBot(name: string): Promise<Docker.ContainerInspectInfo> {
    const container = this.docker.getContainer(name);
    return container.inspect();
  }

  /** Get Docker event stream for monitoring container lifecycle. */
  async getEventStream(opts?: { filters?: Record<string, string[]> }): Promise<NodeJS.ReadableStream> {
    return this.docker.getEvents({
      filters: opts?.filters ?? { type: ["container"] },
    }) as unknown as Promise<NodeJS.ReadableStream>;
  }
}
