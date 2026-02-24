import { connect, type TLSSocket } from "node:tls";
import { logger } from "../config/logger.js";

export interface CertExpiryResult {
  hostname: string;
  port: number;
  valid: boolean;
  daysRemaining?: number;
  expiresAt?: Date;
  issuer?: string;
  error?: string;
}

/**
 * Check TLS certificate expiry for a given hostname:port.
 * Returns cert details including days until expiry.
 */
export function checkCertExpiry(hostname: string, port: number, timeoutMs = 5000): Promise<CertExpiryResult> {
  return new Promise((resolve) => {
    const socket: TLSSocket = connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: true, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();

        if (!cert || !cert.valid_to) {
          resolve({ hostname, port, valid: false, error: "No certificate returned" });
          return;
        }

        const expiresAt = new Date(cert.valid_to);
        const now = new Date();
        const daysRemaining = Math.floor((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        resolve({
          hostname,
          port,
          valid: true,
          daysRemaining,
          expiresAt,
          issuer: cert.issuer?.O || cert.issuer?.CN || "unknown",
        });
      },
    );

    socket.on("error", (err) => {
      socket.destroy();
      resolve({ hostname, port, valid: false, error: err.message });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({ hostname, port, valid: false, error: "Connection timed out" });
    });
  });
}

/** Default domains to monitor — all external-facing endpoints. */
const DEFAULT_DOMAINS = ["wopr.bot", "app.wopr.bot", "api.wopr.bot"];
const ALERT_THRESHOLD_DAYS = 30;

/**
 * Check all platform domains and return results.
 * Logs warnings for certs expiring within threshold.
 */
export async function checkAllCerts(
  domains?: string[],
  thresholdDays = ALERT_THRESHOLD_DAYS,
): Promise<CertExpiryResult[]> {
  const targets = domains ?? DEFAULT_DOMAINS;

  const settled = await Promise.allSettled(targets.map((domain) => checkCertExpiry(domain, 443)));

  return settled.map((outcome) => {
    const result: CertExpiryResult =
      outcome.status === "fulfilled"
        ? outcome.value
        : { hostname: "unknown", port: 443, valid: false, error: String(outcome.reason) };

    // Sanitize: only log the validated hostname from the result struct, not the raw
    // env-derived domain string, to avoid log injection from malformed env values.
    const safeDomain = result.hostname.replace(/[^\w.-]/g, "");

    if (!result.valid) {
      logger.error(`TLS cert check FAILED for ${safeDomain}: ${result.error}`);
    } else if (result.daysRemaining !== undefined && result.daysRemaining < thresholdDays) {
      logger.warn(`TLS cert for ${safeDomain} expires in ${result.daysRemaining} days (threshold: ${thresholdDays})`);
    } else {
      logger.info(`TLS cert for ${safeDomain}: ${result.daysRemaining} days remaining`);
    }

    return result;
  });
}
