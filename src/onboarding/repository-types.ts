export interface OnboardingScript {
  id: string;
  content: string;
  version: number;
  updatedAt: number;
  updatedBy: string | null;
}

export interface NewOnboardingScript {
  content: string;
  updatedBy?: string | null;
}
