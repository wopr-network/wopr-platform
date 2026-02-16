/**
 * In-Memory Implementation: TenantStatusRepository (ASYNC)
 */

import { type TenantAccountStatus, TenantStatus } from "../../domain/entities/tenant-status.js";
import type { TenantStatusRepository } from "../../domain/repositories/tenant-status-repository.js";
import type { TenantId } from "../../domain/value-objects/tenant-id.js";

interface StoredStatus {
  tenantId: string;
  status: TenantAccountStatus;
  statusReason: string | null;
  statusChangedAt: number | null;
  statusChangedBy: string | null;
  graceDeadline: number | null;
  dataDeleteAfter: number | null;
  createdAt: number;
  updatedAt: number;
}

const GRACE_PERIOD_DAYS = 3;
const BAN_DELETE_DAYS = 30;

export class InMemoryTenantStatusRepository implements TenantStatusRepository {
  private statuses = new Map<string, StoredStatus>();

  async get(tenantId: TenantId): Promise<TenantStatus | null> {
    const status = this.statuses.get(tenantId.toString());
    return status ? this.toTenantStatus(status) : null;
  }

  async getStatus(tenantId: TenantId): Promise<TenantAccountStatus> {
    const status = await this.get(tenantId);
    return status?.status ?? "active";
  }

  async ensureExists(tenantId: TenantId): Promise<void> {
    const tenantStr = tenantId.toString();
    if (!this.statuses.has(tenantStr)) {
      const now = Date.now();
      this.statuses.set(tenantStr, {
        tenantId: tenantStr,
        status: "active",
        statusReason: null,
        statusChangedAt: null,
        statusChangedBy: null,
        graceDeadline: null,
        dataDeleteAfter: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async suspend(tenantId: TenantId, reason: string, adminUserId: string): Promise<void> {
    await this.ensureExists(tenantId);
    const tenantStr = tenantId.toString();
    const now = Date.now();
    const existing = this.statuses.get(tenantStr);
    if (!existing) {
      throw new Error("Status not found after ensureExists");
    }

    this.statuses.set(tenantStr, {
      ...existing,
      status: "suspended",
      statusReason: reason,
      statusChangedAt: now,
      statusChangedBy: adminUserId,
      graceDeadline: null,
      updatedAt: now,
    });
  }

  async reactivate(tenantId: TenantId, adminUserId: string): Promise<void> {
    const tenantStr = tenantId.toString();
    const now = Date.now();
    const existing = this.statuses.get(tenantStr);
    if (!existing) {
      throw new Error("Status not found");
    }

    this.statuses.set(tenantStr, {
      ...existing,
      status: "active",
      statusReason: null,
      statusChangedAt: now,
      statusChangedBy: adminUserId,
      graceDeadline: null,
      updatedAt: now,
    });
  }

  async ban(tenantId: TenantId, reason: string, adminUserId: string): Promise<void> {
    await this.ensureExists(tenantId);
    const tenantStr = tenantId.toString();
    const now = Date.now();
    const dataDeleteAfter = now + BAN_DELETE_DAYS * 24 * 60 * 60 * 1000;
    const existing = this.statuses.get(tenantStr);
    if (!existing) {
      throw new Error("Status not found after ensureExists");
    }

    this.statuses.set(tenantStr, {
      ...existing,
      status: "banned",
      statusReason: reason,
      statusChangedAt: now,
      statusChangedBy: adminUserId,
      graceDeadline: null,
      dataDeleteAfter,
      updatedAt: now,
    });
  }

  async setGracePeriod(tenantId: TenantId): Promise<void> {
    await this.ensureExists(tenantId);
    const tenantStr = tenantId.toString();
    const now = Date.now();
    const graceDeadline = now + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    const existing = this.statuses.get(tenantStr);
    if (!existing) {
      throw new Error("Status not found after ensureExists");
    }

    this.statuses.set(tenantStr, {
      ...existing,
      status: "grace_period",
      statusChangedAt: now,
      graceDeadline,
      updatedAt: now,
    });
  }

  async expireGracePeriods(): Promise<string[]> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [tenantId, status] of this.statuses) {
      if (status.status === "grace_period" && status.graceDeadline && status.graceDeadline <= now) {
        this.statuses.set(tenantId, {
          ...status,
          status: "suspended",
          statusReason: "Grace period expired",
          statusChangedAt: now,
          statusChangedBy: "system",
          graceDeadline: null,
          updatedAt: now,
        });
        expired.push(tenantId);
      }
    }

    return expired;
  }

  async isOperational(tenantId: TenantId): Promise<boolean> {
    const status = await this.getStatus(tenantId);
    return status === "active" || status === "grace_period";
  }

  clear(): void {
    this.statuses.clear();
  }

  private toTenantStatus(status: StoredStatus): TenantStatus {
    return TenantStatus.fromRow({
      tenantId: status.tenantId,
      status: status.status,
      statusReason: status.statusReason,
      statusChangedAt: status.statusChangedAt,
      statusChangedBy: status.statusChangedBy,
      graceDeadline: status.graceDeadline ? String(status.graceDeadline) : null,
      dataDeleteAfter: status.dataDeleteAfter ? String(status.dataDeleteAfter) : null,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt,
    });
  }
}
