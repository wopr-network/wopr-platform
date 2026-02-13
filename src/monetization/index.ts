/**
 * Monetization — the platform's billing and metering layer.
 *
 * Core never knows about billing, tenancy, or tiers. All monetization
 * lives here in the platform backend.
 *
 * Planned modules (see WOP-216 epic):
 * - socket/    — withMargin() wrapper (WOP-298)
 * - metering/  — fire-and-forget usage events (WOP-299)
 * - stripe/    — Stripe usage-based billing (WOP-300)
 * - adapters/  — hosted adapters like woprReplicateAdapter (WOP-301)
 */
