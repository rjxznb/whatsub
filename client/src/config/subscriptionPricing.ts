export const SUBSCRIPTION_PRICING = {
  currency: "CNY",
  monthly: 38,
  yearly: 348,
} as const;

export const MONTHLY_PRICE_TEXT = `¥${SUBSCRIPTION_PRICING.monthly}`;
export const YEARLY_PRICE_TEXT = `¥${SUBSCRIPTION_PRICING.yearly}`;
