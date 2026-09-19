import { text } from './news/render.js';
import { formatUsd } from './money.js';
import { usageMemberRows } from './limits.js';
import type { UsageFacts } from './i18n/shapes.js';
import type { BudgetSummary, UsageSummary } from './types.js';

const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * A fixed-scale sparkline. An all-zero window renders as a flat baseline rather than an
 * empty string, so a quiet week still reads as a timeline instead of missing data.
 */
export const sparkline = (values: readonly number[]) => {
  if (!values.length) return '';
  const peak = Math.max(...values);
  return values
    .map((value) => {
      if (peak <= 0) return blocks[0];
      const scaled = Math.ceil((value / peak) * (blocks.length - 1));
      return blocks[Math.max(0, Math.min(blocks.length - 1, scaled))];
    })
    .join('');
};

/**
 * Resolves pseudonymous member keys back to display names where possible.
 *
 * Member identifiers are HMAC-pseudonymized before storage, so the only way back is to hash
 * the identifiers we already know and match. Anyone not in the supplied set — a member who
 * left, or one Discord has not cached — is deliberately grouped rather than shown as a hash.
 */
export const usageFacts = (input: {
  summary: UsageSummary;
  budget: BudgetSummary;
  monthlyLimitMicrodollars: number;
  knownMembers: ReadonlyMap<string, string>;
  othersLabel: string;
  maximumRows?: number;
}): UsageFacts => {
  const maximumRows = input.maximumRows ?? usageMemberRows;
  // Totals stay as raw microdollars until the very end, so folded rows keep their spend
  // instead of being added as already-formatted strings.
  type Totals = { requests: number; costMicrodollars: number; failures: number };
  const add = (left: Totals, right: Totals): Totals => ({
    requests: left.requests + right.requests,
    costMicrodollars: left.costMicrodollars + right.costMicrodollars,
    failures: left.failures + right.failures,
  });
  const empty: Totals = { requests: 0, costMicrodollars: 0, failures: 0 };
  const named: (Totals & { name: string })[] = [];
  let others = empty;
  for (const member of input.summary.members) {
    const name = input.knownMembers.get(member.userKey);
    const totals: Totals = {
      requests: member.requests,
      costMicrodollars: member.costMicrodollars,
      failures: member.failures,
    };
    if (name) named.push({ name, ...totals });
    else others = add(others, totals);
  }
  // Rows beyond the cap fold into the same grouped row, so no spend is silently dropped.
  for (const overflow of named.splice(maximumRows)) others = add(others, overflow);
  const othersIncluded = others.requests > 0;

  return {
    windowDays: input.summary.trendDays,
    memberWindowDays: input.summary.memberWindowDays,
    trend: input.summary.trend,
    sparkline: sparkline(input.summary.trend.map((day) => day.costMicrodollars)),
    totalCost: formatUsd(input.summary.totalCostMicrodollars),
    dailyCost: formatUsd(
      input.budget.dailyUsedMicrodollars + input.budget.dailyReservedMicrodollars,
    ),
    monthlyCost: formatUsd(
      input.budget.monthlyUsedMicrodollars + input.budget.monthlyReservedMicrodollars,
    ),
    monthlyLimit: formatUsd(input.monthlyLimitMicrodollars),
    members: [...named, ...(othersIncluded ? [{ ...others, name: input.othersLabel }] : [])].map(
      ({ name, requests, costMicrodollars, failures }) => ({
        name: text(name, 48),
        requests,
        cost: formatUsd(costMicrodollars),
        failures,
      }),
    ),
    othersIncluded,
  };
};
