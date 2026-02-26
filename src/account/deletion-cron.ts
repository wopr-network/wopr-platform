import { type DeletionExecutorDeps, type DeletionResult, executeDeletion } from "./deletion-executor.js";
import type { AccountDeletionStore } from "./deletion-store.js";

export interface DeletionCronResult {
  processed: number;
  succeeded: number;
  failed: number;
  results: DeletionResult[];
}

type ExecutorFn = (deps: DeletionExecutorDeps, tenantId: string) => Promise<DeletionResult>;

/**
 * Process all deletion requests whose grace period has expired.
 * Called on a timer (e.g., every hour or daily).
 */
export async function runDeletionCron(
  store: AccountDeletionStore,
  executorDeps: DeletionExecutorDeps,
): Promise<DeletionCronResult> {
  return runDeletionCronWithExecutor(store, executorDeps, executeDeletion);
}

/**
 * Testable variant that accepts an executor function injection.
 */
export async function runDeletionCronWithExecutor(
  store: AccountDeletionStore,
  executorDeps: DeletionExecutorDeps,
  executor: ExecutorFn,
): Promise<DeletionCronResult> {
  const expired = await store.findExpired();
  const cronResult: DeletionCronResult = {
    processed: expired.length,
    succeeded: 0,
    failed: 0,
    results: [],
  };

  for (const request of expired) {
    try {
      const result = await executor(executorDeps, request.tenantId);
      await store.markCompleted(request.id, result.deletedCounts);
      cronResult.succeeded++;
      cronResult.results.push(result);
    } catch (_err) {
      cronResult.failed++;
    }
  }

  return cronResult;
}
