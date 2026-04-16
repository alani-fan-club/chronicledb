export interface BudgetProfile {
  events: number;
  dialogue: number;
  memory: number;
  snapshots: number;
  maxTokens: number;
}

export interface ResolveBudgetsResult extends BudgetProfile {
  profile: string;
}

export type ResolveBudgetsOverrides = Partial<BudgetProfile> | null | undefined;

export type ResolveBudgetsSettings = {
  maxInjectionTokens?: unknown;
  [key: string]: unknown;
} | null | undefined;

export const BUDGET_PROFILES: {
  inject: BudgetProfile;
  characterPanel: BudgetProfile;
  mindmap: BudgetProfile;
  [profileName: string]: BudgetProfile;
};

export function resolveBudgets(
  settings: ResolveBudgetsSettings,
  profileName?: string | null,
  overrides?: ResolveBudgetsOverrides,
): ResolveBudgetsResult;
