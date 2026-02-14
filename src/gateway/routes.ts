/**
 * Gateway routes — mounts all /v1/... endpoints behind service key auth.
 *
 * This is the external API surface that bots consume. All routes require
 * a valid WOPR service key and follow the authenticate -> budget check ->
 * proxy -> meter -> respond pattern.
 */

import { Hono } from "hono";
import {
  audioSpeech,
  audioTranscriptions,
  buildProxyDeps,
  chatCompletions,
  embeddings,
  imageGenerations,
  phoneInbound,
  phoneOutbound,
  smsInbound,
  smsOutbound,
  textCompletions,
  videoGenerations,
} from "./proxy.js";
import { type GatewayAuthEnv, serviceKeyAuth } from "./service-key-auth.js";
import type { GatewayConfig } from "./types.js";

/**
 * Create the gateway router with all /v1/... endpoints.
 *
 * @param config - Gateway configuration (providers, meter, budget checker, etc.)
 * @returns Hono app to mount at /v1 in the main app
 */
export function createGatewayRoutes(config: GatewayConfig): Hono<GatewayAuthEnv> {
  const gateway = new Hono<GatewayAuthEnv>();
  const deps = buildProxyDeps(config);

  // All gateway routes require service key authentication
  gateway.use("/*", serviceKeyAuth(config.resolveServiceKey));

  // LLM endpoints (OpenRouter)
  gateway.post("/chat/completions", chatCompletions(deps));
  gateway.post("/completions", textCompletions(deps));
  gateway.post("/embeddings", embeddings(deps));

  // Audio endpoints
  gateway.post("/audio/transcriptions", audioTranscriptions(deps));
  gateway.post("/audio/speech", audioSpeech(deps));

  // Image & Video generation (Replicate)
  gateway.post("/images/generations", imageGenerations(deps));
  gateway.post("/video/generations", videoGenerations(deps));

  // Phone (Twilio/Telnyx)
  gateway.post("/phone/outbound", phoneOutbound(deps));
  gateway.post("/phone/inbound", phoneInbound(deps));

  // SMS/MMS (Twilio/Telnyx)
  gateway.post("/messages/sms", smsOutbound(deps));
  gateway.post("/messages/sms/inbound", smsInbound(deps));

  return gateway;
}
