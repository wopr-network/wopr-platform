import { logger } from "../config/logger.js";

export type PagerDutySeverity = "critical" | "error" | "warning" | "info";

export interface PagerDutyConfig {
  enabled: boolean;
  routingKey: string;
  afterHoursRoutingKey?: string;
  businessHoursStart: number;
  businessHoursEnd: number;
}

const EVENTS_API_URL = "https://events.pagerduty.com/v2/enqueue";
const SOURCE = "wopr-platform";

export class PagerDutyNotifier {
  private readonly config: PagerDutyConfig;

  constructor(config: PagerDutyConfig) {
    this.config = config;
  }

  async trigger(
    alertName: string,
    summary: string,
    severity: PagerDutySeverity,
    customDetails?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.enabled || !this.config.routingKey) return;

    await this.send({
      routing_key: this.getRoutingKey(),
      event_action: "trigger",
      dedup_key: `${SOURCE}:${alertName}`,
      payload: {
        summary,
        source: SOURCE,
        severity,
        component: alertName,
        custom_details: customDetails,
      },
    });
  }

  async resolve(alertName: string): Promise<void> {
    if (!this.config.enabled || !this.config.routingKey) return;

    await this.send({
      routing_key: this.getRoutingKey(),
      event_action: "resolve",
      dedup_key: `${SOURCE}:${alertName}`,
      payload: {
        summary: `Resolved: ${alertName}`,
        source: SOURCE,
        severity: "info",
      },
    });
  }

  private getRoutingKey(): string {
    const hour = new Date().getUTCHours();
    const inBusinessHours = hour >= this.config.businessHoursStart && hour < this.config.businessHoursEnd;

    if (!inBusinessHours && this.config.afterHoursRoutingKey) {
      return this.config.afterHoursRoutingKey;
    }
    return this.config.routingKey;
  }

  private async send(event: {
    routing_key: string;
    event_action: string;
    dedup_key: string;
    payload: {
      summary: string;
      source: string;
      severity: PagerDutySeverity;
      component?: string;
      custom_details?: Record<string, unknown>;
    };
  }): Promise<void> {
    try {
      const response = await fetch(EVENTS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });

      if (response.status !== 202) {
        logger.warn(`PagerDuty Events API returned ${response.status} ${response.statusText}`, {
          alertName: event.dedup_key,
        });
      }
    } catch (err) {
      logger.error("PagerDuty Events API request failed", { err, alertName: event.dedup_key });
    }
  }
}
