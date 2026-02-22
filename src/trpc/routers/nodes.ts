import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { IBotInstanceRepository } from "../../fleet/bot-instance-repository.js";
import type { NodeConnectionRegistry } from "../../fleet/node-connection-registry.js";
import type { INodeRepository } from "../../fleet/node-repository.js";
import type { RegistrationTokenStore } from "../../fleet/registration-token-store.js";
import { protectedProcedure, router } from "../init.js";

export interface NodesRouterDeps {
  getRegistrationTokenStore: () => RegistrationTokenStore;
  getNodeRepo: () => INodeRepository;
  getConnectionRegistry: () => NodeConnectionRegistry;
  getBotInstanceRepo: () => IBotInstanceRepository;
}

let _deps: NodesRouterDeps | null = null;

export function setNodesRouterDeps(deps: NodesRouterDeps): void {
  _deps = deps;
}

function deps(): NodesRouterDeps {
  if (!_deps) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Nodes router not initialized" });
  return _deps;
}

export const nodesRouter = router({
  /** Generate a one-time registration token for connecting hardware. */
  createRegistrationToken: protectedProcedure
    .input(
      z.object({
        label: z.string().max(100).optional(),
      }),
    )
    .mutation(({ input, ctx }) => {
      const store = deps().getRegistrationTokenStore();
      const { token, expiresAt } = store.create(ctx.user.id, input.label);

      return {
        token,
        expiresAt,
        installCommand: `curl -sSL https://install.wopr.bot/agent | bash -s -- ${token}`,
        npmCommand: `REGISTRATION_TOKEN=${token} npx @wopr-network/node-agent`,
      };
    }),

  /** List nodes owned by the current user with live connection status. */
  list: protectedProcedure.query(({ ctx }) => {
    const nodeRepo = deps().getNodeRepo();
    const registry = deps().getConnectionRegistry();
    const allNodes = nodeRepo.list();

    const isAdmin = ctx.user.roles.includes("platform_admin");
    const userNodes = isAdmin ? allNodes : allNodes.filter((n) => n.ownerUserId === ctx.user.id);

    return userNodes.map((node) => ({
      id: node.id,
      label: node.label ?? node.id,
      host: node.host,
      status: node.status,
      isConnected: registry.isConnected(node.id),
      capacityMb: node.capacityMb,
      usedMb: node.usedMb,
      agentVersion: node.agentVersion,
      lastHeartbeatAt: node.lastHeartbeatAt,
      registeredAt: node.registeredAt,
    }));
  }),

  /** Get detailed status of a specific node. */
  get: protectedProcedure.input(z.object({ nodeId: z.string().min(1) })).query(({ input, ctx }) => {
    const nodeRepo = deps().getNodeRepo();
    const registry = deps().getConnectionRegistry();
    const botInstanceRepo = deps().getBotInstanceRepo();
    const node = nodeRepo.getById(input.nodeId);

    if (!node) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Node not found" });
    }

    const isAdmin = ctx.user.roles.includes("platform_admin");
    if (!isAdmin && node.ownerUserId !== ctx.user.id) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Node not found" });
    }

    const now = Math.floor(Date.now() / 1000);
    const lastSeenAgo = node.lastHeartbeatAt != null ? now - node.lastHeartbeatAt : null;

    return {
      ...node,
      isConnected: registry.isConnected(input.nodeId),
      lastSeenAgoS: lastSeenAgo,
      tenants: botInstanceRepo.listByNode(input.nodeId),
    };
  }),

  /** Remove a self-hosted node (deregister). */
  remove: protectedProcedure.input(z.object({ nodeId: z.string().min(1) })).mutation(({ input, ctx }) => {
    const nodeRepo = deps().getNodeRepo();
    const registry = deps().getConnectionRegistry();
    const botInstanceRepo = deps().getBotInstanceRepo();
    const node = nodeRepo.getById(input.nodeId);

    if (!node) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Node not found" });
    }

    if (node.ownerUserId !== ctx.user.id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Not your node" });
    }

    const tenants = botInstanceRepo.listByNode(input.nodeId);
    if (tenants.length > 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Node has ${tenants.length} active bot(s). Migrate them first.`,
      });
    }

    registry.close(input.nodeId);
    nodeRepo.delete(input.nodeId);
    return { success: true };
  }),

  /** List active (unused, unexpired) registration tokens. */
  listTokens: protectedProcedure.query(({ ctx }) => {
    const store = deps().getRegistrationTokenStore();
    return store.listActive(ctx.user.id);
  }),
});
