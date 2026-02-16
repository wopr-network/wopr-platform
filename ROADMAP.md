# Repository Pattern Refactor - Implementation Roadmap

## Current State Analysis

### The Problem
- **253 files** import from `drizzle-orm` directly
- Business logic is tightly coupled to SQLite/Drizzle
- Cannot unit test without database
- Schema changes require changes across many files
- No abstraction layer between domain and persistence

### Key Files to Refactor (Priority Order)

#### Phase 1: Foundation (Stream 1)
Create domain layer structure and first repository.

**Target:** `CreditLedger` → `CreditRepository`
- File: `src/monetization/credits/credit-ledger.ts`
- Lines: ~200
- Complexity: Medium (has transactions)
- Impact: High (core billing component)

#### Phase 2: Critical Monetization (Stream 2)
- `BotBilling` (`src/monetization/credits/bot-billing.ts`)
- `TenantStore` (`src/monetization/stripe/tenant-store.ts`)
- Metering repositories

#### Phase 3: Fleet Management (Stream 3)
- `NodeConnectionManager` (`src/fleet/node-connection-manager.ts`)
- `RecoveryManager` (`src/fleet/recovery-manager.ts`)
- `ProfileStore` (`src/fleet/profile-store.ts`)

#### Phase 4: Admin & Security (Stream 4)
- `TenantStatusStore` (`src/admin/tenant-status/tenant-status-store.ts`)
- `UserStore` (`src/admin/users/user-store.ts`)
- `CredentialVault` (`src/security/credential-vault/store.ts`)

## Implementation Strategy

### 1. Domain Layer First

Create clean domain interfaces with NO database dependencies:

```
src/domain/
├── entities/          # Domain entities (pure TypeScript)
│   ├── credit/
│   │   ├── credit-balance.ts
│   │   ├── credit-transaction.ts
│   │   └── errors.ts
│   └── tenant/
│       ├── tenant.ts
│       └── tenant-id.ts
├── repositories/      # Repository interfaces (contracts)
│   ├── credit-repository.ts
│   ├── bot-repository.ts
│   └── tenant-repository.ts
├── value-objects/     # Value objects for type safety
│   ├── money.ts
│   ├── tenant-id.ts
│   └── transaction-id.ts
└── services/          # Domain services (business logic)
    └── credit-service.ts
```

### 2. Infrastructure Layer

Implement repositories using Drizzle:

```
src/infrastructure/
├── persistence/
│   ├── drizzle/
│   │   ├── drizzle-credit-repository.ts
│   │   ├── drizzle-bot-repository.ts
│   │   └── mappers/
│   │       ├── credit-balance-mapper.ts
│   │       └── credit-transaction-mapper.ts
│   └── in-memory/     # For testing
│       ├── in-memory-credit-repository.ts
│       └── in-memory-bot-repository.ts
└── di/
    └── container.ts   # Dependency injection
```

### 3. Migration Approach

For each repository:

1. **Define Interface** (domain layer)
   - Extract methods from existing store
   - Use domain types (no Drizzle types)
   - Define error types

2. **Create Drizzle Implementation**
   - Copy logic from existing store
   - Map Drizzle rows to domain entities
   - Keep transactions intact

3. **Create In-Memory Implementation**
   - Simple Map-based storage
   - For unit testing
   - Same interface as Drizzle version

4. **Refactor Existing Code**
   - Replace store usage with repository interface
   - Inject via constructor
   - Update tests

5. **Delete Old Store**
   - Remove original file
   - Update imports

### 4. Example: CreditLedger → CreditRepository

**Current (CreditLedger):**
```typescript
export class CreditLedger {
  constructor(private readonly db: DrizzleDb) {}
  
  credit(tenantId: string, amountCents: number, ...): CreditTransaction {
    return this.db.transaction((tx) => {
      // Drizzle queries...
    });
  }
}
```

**Target Interface:**
```typescript
export interface CreditRepository {
  credit(tenantId: TenantId, amount: Money, type: CreditType): Promise<CreditTransaction>;
  debit(tenantId: TenantId, amount: Money, type: DebitType): Promise<CreditTransaction>;
  getBalance(tenantId: TenantId): Promise<Money>;
  getTransactionHistory(tenantId: TenantId, options: HistoryOptions): Promise<TransactionPage>;
}
```

**Key Changes:**
- `string` → `TenantId` (value object)
- `number` (cents) → `Money` (value object)
- Synchronous → Asynchronous (Future-proofing)
- No `DrizzleDb` in interface

## Value Objects to Create

### 1. TenantId
```typescript
export class TenantId {
  private constructor(private readonly value: string) {}
  
  static create(value: string): TenantId {
    if (!value || value.length === 0) throw new Error('Invalid tenant ID');
    return new TenantId(value);
  }
  
  equals(other: TenantId): boolean {
    return this.value === other.value;
  }
  
  toString(): string {
    return this.value;
  }
}
```

### 2. Money
```typescript
export class Money {
  private constructor(private readonly cents: number) {}
  
  static fromCents(cents: number): Money {
    if (cents < 0) throw new Error('Money cannot be negative');
    return new Money(cents);
  }
  
  static fromDollars(dollars: number): Money {
    return new Money(Math.round(dollars * 100));
  }
  
  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }
  
  subtract(other: Money): Money {
    return new Money(this.cents - other.cents);
  }
  
  isGreaterThan(other: Money): boolean {
    return this.cents > other.cents;
  }
  
  toCents(): number {
    return this.cents;
  }
  
  toDollars(): number {
    return this.cents / 100;
  }
}
```

### 3. TransactionId
```typescript
export class TransactionId {
  private constructor(private readonly value: string) {}
  
  static generate(): TransactionId {
    return new TransactionId(crypto.randomUUID());
  }
  
  static fromString(value: string): TransactionId {
    return new TransactionId(value);
  }
  
  toString(): string {
    return this.value;
  }
}
```

## Testing Strategy

### Contract Tests
Ensure both implementations behave identically:

```typescript
describe('CreditRepository Contract', () => {
  runRepositoryTests('DrizzleCreditRepository', createDrizzleRepo);
  runRepositoryTests('InMemoryCreditRepository', createInMemoryRepo);
});

function runRepositoryTests(name: string, createRepo: () => CreditRepository) {
  describe(name, () => {
    it('should credit account', async () => {
      const repo = createRepo();
      const tenantId = TenantId.create('tenant-1');
      
      await repo.credit(tenantId, Money.fromCents(1000), 'purchase');
      
      const balance = await repo.getBalance(tenantId);
      expect(balance.toCents()).toBe(1000);
    });
    
    // ... more tests
  });
}
```

### Unit Tests
Use in-memory repository for fast tests:

```typescript
describe('CreditService', () => {
  let service: CreditService;
  let repo: InMemoryCreditRepository;
  
  beforeEach(() => {
    repo = new InMemoryCreditRepository();
    service = new CreditService(repo);
  });
  
  it('should process purchase', async () => {
    // Fast, no database needed
  });
});
```

## Migration Order

### Week 1: Foundation
1. Create domain directory structure
2. Define value objects (TenantId, Money, TransactionId)
3. Extract CreditRepository interface
4. Implement DrizzleCreditRepository
5. Implement InMemoryCreditRepository
6. Write contract tests

### Week 2-3: Monetization Repositories (Parallel)
- BotBillingRepository
- TenantCreditRepository
- MeterEventRepository

### Week 4: Fleet Repositories (Parallel)
- NodeRepository
- BotInstanceRepository
- RecoveryRepository

### Week 5: Admin & Security (Parallel)
- TenantRepository
- UserRepository
- CredentialRepository

### Week 6: Cleanup
- Delete old store files
- Update API routes
- Performance benchmarks
- Documentation

## Risk Mitigation

1. **Incremental Migration**: One repository at a time
2. **Feature Flags**: Can rollback individual repositories
3. **Dual Implementation**: Keep old + new side-by-side temporarily
4. **Contract Tests**: Ensure behavior parity
5. **Integration Tests**: Verify Drizzle implementation

## Success Metrics

- [ ] CreditLedger refactored to CreditRepository
- [ ] Unit tests run without database (< 100ms)
- [ ] No `drizzle-orm` imports in domain/ layer
- [ ] All repositories have in-memory implementations
- [ ] Contract tests passing for all repositories

## Open Questions

1. Should we use a DI library (tsyringe, inversify) or simple constructor injection?
2. How to handle transactions across multiple repositories?
3. Should entities be mutable or immutable?
4. Pagination strategy for history queries?
5. Error handling strategy (custom errors vs Result types)?

## Next Steps

1. ✅ Create worktree (done)
2. ⬜ Create value objects (TenantId, Money)
3. ⬜ Define CreditRepository interface
4. ⬜ Implement DrizzleCreditRepository
5. ⬜ Implement InMemoryCreditRepository
6. ⬜ Write contract tests
7. ⬜ Refactor existing code to use repository
