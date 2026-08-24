import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { API_BASE } from "../apiBase";

const BASE = API_BASE;

export type TokenProductId = "whatsub_token_1m" | "whatsub_token_5m" | "whatsub_token_15m";

export interface TokenTopupProduct {
  id: TokenProductId;
  tokens: number;
  priceCny: string;
}

export interface TokenWallet {
  monthlyUsed: number;
  monthlyLimit: number;
  topupBalance: number;
  topupFrozen: boolean;
  periodResetAt: number;
}

export interface TokenTransaction {
  productId: TokenProductId | null;
  tokenDelta: number;
  createdAt: number;
}

async function token(): Promise<string> {
  const value = await invoke<string | null>("get_session_token");
  if (!value) throw new Error("auth_required");
  return value;
}

async function get<T>(path: string): Promise<T> {
  const bearer = await token();
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!response.ok) throw new Error(`token_wallet_http_${response.status}`);
  return response.json() as Promise<T>;
}

export function getTokenTopupCatalog(): Promise<TokenTopupProduct[]> {
  return fetch(`${BASE}/llm/topups/catalog`).then(async (response) => {
    if (!response.ok) throw new Error(`token_catalog_http_${response.status}`);
    const data = await response.json() as { products: TokenTopupProduct[] };
    return data.products;
  });
}

export function getTokenWallet(): Promise<TokenWallet> {
  return get<TokenWallet>("/llm/topups/wallet");
}

export function getTokenHistory(): Promise<TokenTransaction[]> {
  return get<{ transactions: TokenTransaction[] }>("/llm/topups/history")
    .then((data) => data.transactions);
}

export async function createTokenTopupOrder(product: TokenProductId): Promise<{
  outTradeNo: string;
  payUrl: string;
}> {
  const bearer = await token();
  const response = await fetch(`${BASE}/payment/token-topup/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ product }),
  });
  if (!response.ok) throw new Error(`token_order_http_${response.status}`);
  return response.json();
}
