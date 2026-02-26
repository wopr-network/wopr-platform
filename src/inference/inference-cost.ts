interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-20250514": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  "claude-haiku-4-5-20251001": {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.08,
    cacheWritePerMillion: 1.0,
  },
};

export function computeInferenceCost(usage: TokenUsage): number {
  const pricing = MODEL_PRICING[usage.model];
  if (!pricing) return 0;

  const nonCachedInput = usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens;
  const inputCost = (nonCachedInput * pricing.inputPerMillion) / 1_000_000;
  const cachedCost = (usage.cachedTokens * pricing.cacheReadPerMillion) / 1_000_000;
  const cacheWriteCost = (usage.cacheWriteTokens * pricing.cacheWritePerMillion) / 1_000_000;
  const outputCost = (usage.outputTokens * pricing.outputPerMillion) / 1_000_000;

  return inputCost + cachedCost + cacheWriteCost + outputCost;
}
