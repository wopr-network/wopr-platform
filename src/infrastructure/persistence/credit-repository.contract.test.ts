import { describe, it, expect, beforeEach } from 'vitest';
import type { CreditRepository } from '../../domain/repositories/credit-repository.js';
import { InsufficientBalanceError } from '../../domain/repositories/credit-repository.js';
import { TenantId } from '../../domain/value-objects/tenant-id.js';
import { Money } from '../../domain/value-objects/money.js';
import { DrizzleCreditRepository } from './drizzle-credit-repository.js';
import { InMemoryCreditRepository } from './in-memory-credit-repository.js';
import { createTestDb } from '../../test/db.js';

describe('CreditRepository Contract', () => {
  runRepositoryContractTests('DrizzleCreditRepository', async () => {
    const { db } = createTestDb();
    return new DrizzleCreditRepository(db);
  });

  runRepositoryContractTests('InMemoryCreditRepository', async () => {
    return new InMemoryCreditRepository();
  });
});

function runRepositoryContractTests(
  name: string,
  createRepo: () => Promise<CreditRepository> | CreditRepository
) {
  describe(name, () => {
    let repo: CreditRepository;
    let tenantId: TenantId;

    beforeEach(async () => {
      repo = await createRepo();
      tenantId = TenantId.create('test-tenant-1');
    });

    describe('credit', () => {
      it('should add credits to a new tenant', async () => {
        const transaction = await repo.credit(
          tenantId,
          Money.fromCents(1000),
          'purchase',
          'Test purchase',
          'ref-123'
        );

        expect(transaction.tenantId.equals(tenantId)).toBe(true);
        expect(transaction.amount.toCents()).toBe(1000);
        expect(transaction.balanceAfter.toCents()).toBe(1000);
        expect(transaction.type).toBe('purchase');
        expect(transaction.description).toBe('Test purchase');
        expect(transaction.referenceId).toBe('ref-123');
        expect(transaction.isCredit()).toBe(true);
      });

      it('should accumulate credits', async () => {
        await repo.credit(tenantId, Money.fromCents(1000), 'purchase');
        await repo.credit(tenantId, Money.fromCents(500), 'referral');

        const balance = await repo.getBalance(tenantId);
        expect(balance.balance.toCents()).toBe(1500);
      });
    });

    describe('debit', () => {
      beforeEach(async () => {
        await repo.credit(tenantId, Money.fromCents(1000), 'purchase');
      });

      it('should deduct credits', async () => {
        const transaction = await repo.debit(
          tenantId,
          Money.fromCents(300),
          'adapter_usage'
        );

        expect(transaction.amount.toCents()).toBe(300);
        expect(transaction.balanceAfter.toCents()).toBe(700);
        expect(transaction.isDebit()).toBe(true);
      });

      it('should reject insufficient balance', async () => {
        await expect(
          repo.debit(tenantId, Money.fromCents(1500), 'adapter_usage')
        ).rejects.toThrow(InsufficientBalanceError);
      });
    });

    describe('getBalance', () => {
      it('should return zero for new tenant', async () => {
        const balance = await repo.getBalance(tenantId);
        expect(balance.balance.toCents()).toBe(0);
        expect(balance.isZero()).toBe(true);
      });

      it('should return correct balance', async () => {
        await repo.credit(tenantId, Money.fromCents(1000), 'purchase');
        const balance = await repo.getBalance(tenantId);
        expect(balance.balance.toCents()).toBe(1000);
      });
    });

    describe('hasSufficientBalance', () => {
      beforeEach(async () => {
        await repo.credit(tenantId, Money.fromCents(1000), 'purchase');
      });

      it('should return true when sufficient', async () => {
        expect(await repo.hasSufficientBalance(tenantId, Money.fromCents(500))).toBe(true);
      });

      it('should return false when insufficient', async () => {
        expect(await repo.hasSufficientBalance(tenantId, Money.fromCents(1500))).toBe(false);
      });
    });

    describe('hasReferenceId', () => {
      it('should return false for unused reference', async () => {
        expect(await repo.hasReferenceId('unused-ref')).toBe(false);
      });

      it('should return true for used reference', async () => {
        await repo.credit(tenantId, Money.fromCents(1000), 'purchase', 'desc', 'used-ref');
        expect(await repo.hasReferenceId('used-ref')).toBe(true);
      });
    });

    describe('getTenantsWithPositiveBalance', () => {
      it('should return empty when no tenants', async () => {
        const tenants = await repo.getTenantsWithPositiveBalance();
        expect(tenants).toHaveLength(0);
      });

      it('should return only tenants with positive balance', async () => {
        const tenant2 = TenantId.create('tenant-2');
        const tenant3 = TenantId.create('tenant-3');

        await repo.credit(tenantId, Money.fromCents(1000), 'purchase');
        await repo.credit(tenant2, Money.fromCents(500), 'purchase');
        // tenant3 has no balance

        const tenants = await repo.getTenantsWithPositiveBalance();
        expect(tenants).toHaveLength(2);
        
        const ids = tenants.map((t) => t.tenantId.toString());
        expect(ids).toContain(tenantId.toString());
        expect(ids).toContain(tenant2.toString());
        expect(ids).not.toContain(tenant3.toString());
      });
    });

    describe('getTransactionHistory', () => {
      beforeEach(async () => {
        await repo.credit(tenantId, Money.fromCents(1000), 'purchase');
        await repo.debit(tenantId, Money.fromCents(100), 'adapter_usage');
        await repo.credit(tenantId, Money.fromCents(500), 'referral');
      });

      it('should return transactions newest first', async () => {
        const page = await repo.getTransactionHistory(tenantId);
        expect(page.transactions).toHaveLength(3);
        expect(page.transactions[0].type).toBe('referral');
        expect(page.transactions[1].type).toBe('adapter_usage');
      });

      it('should support pagination', async () => {
        const page1 = await repo.getTransactionHistory(tenantId, { limit: 2 });
        expect(page1.transactions).toHaveLength(2);
        expect(page1.hasMore).toBe(true);
      });
    });
  });
}
