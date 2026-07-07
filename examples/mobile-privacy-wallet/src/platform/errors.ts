export class MobileWalletConfigurationError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "MobileWalletConfigurationError";
    this.details = details;
  }
}

export function blockedGate(input: {
  id: string;
  title: string;
  summary: string;
  evidence?: string;
}) {
  return {
    id: input.id,
    title: input.title,
    status: "blocked" as const,
    summary: input.summary,
    evidence: input.evidence
  };
}

