export interface OnboardingConfig {
  woprPort: number;
  llmProvider: string;
  llmModel: string;
  budgetCapCents: number;
  woprDataDir: string;
  enabled: boolean;
}

export function loadOnboardingConfig(): OnboardingConfig {
  return {
    woprPort: Number(process.env.ONBOARDING_WOPR_PORT || 3847),
    llmProvider: process.env.ONBOARDING_LLM_PROVIDER ?? "anthropic",
    llmModel: process.env.ONBOARDING_LLM_MODEL ?? "claude-sonnet-4-20250514",
    budgetCapCents: Number(process.env.ONBOARDING_BUDGET_CAP_CENTS ?? 100),
    woprDataDir: process.env.ONBOARDING_WOPR_DATA_DIR ?? "/data/platform/onboarding-wopr",
    enabled: process.env.ONBOARDING_ENABLED !== "false",
  };
}
