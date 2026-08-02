import { randomInt } from 'crypto';
import { readAdapterState, writeAdapterState } from '../state.js';

/**
 * Chat authorization for the Telegram bot.
 *
 * The bot can tick tasks and archive changes, so an unauthenticated chat is a
 * write path into the repository. A bot token is a bearer credential that ends
 * up in shell history, process listings and environment dumps — so the token
 * alone is never treated as proof of identity. Every update is checked against
 * an explicit chat allowlist, and the allowlist can only be extended by pasting
 * a short-lived code generated on the machine that owns the project.
 */

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_CODE_DIGITS = 8;

export interface TelegramExtra {
  /** Chats added by pairing, on top of the config allowlist. */
  pairedChatIds?: number[];
  pendingPairing?: { code: string; expiresAt: string };
}

/**
 * Generates an 8-digit code using a CSPRNG.
 *
 * `Math.random` is unsuitable: its output is predictable from a few samples,
 * and this code is the only thing standing between a stranger who found the bot
 * and write access to the project.
 */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_DIGITS; i++) code += String(randomInt(0, 10));
  return code;
}

export async function createPairing(
  projectRoot: string,
  now: Date = new Date()
): Promise<{ code: string; expiresAt: string }> {
  const state = await readAdapterState(projectRoot, 'telegram');
  const extra = (state.extra ?? {}) as TelegramExtra;

  const pairing = {
    code: generatePairingCode(),
    expiresAt: new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString(),
  };

  state.extra = { ...extra, pendingPairing: pairing };
  await writeAdapterState(projectRoot, 'telegram', state);

  return pairing;
}

export type PairingResult =
  | { ok: true; chatId: number }
  | { ok: false; reason: 'no-pending' | 'expired' | 'mismatch' };

/**
 * Redeems a pairing code for a chat id.
 *
 * The code is consumed whatever the outcome of a *match*: single-use is the
 * point. A mismatch does not consume it, so a typo is recoverable, but it also
 * does not leak whether the guess was close.
 */
export async function redeemPairing(
  projectRoot: string,
  chatId: number,
  code: string,
  now: Date = new Date()
): Promise<PairingResult> {
  const state = await readAdapterState(projectRoot, 'telegram');
  const extra = (state.extra ?? {}) as TelegramExtra;
  const pending = extra.pendingPairing;

  if (!pending) return { ok: false, reason: 'no-pending' };

  if (new Date(pending.expiresAt).getTime() < now.getTime()) {
    state.extra = { ...extra, pendingPairing: undefined };
    await writeAdapterState(projectRoot, 'telegram', state);
    return { ok: false, reason: 'expired' };
  }

  if (!constantTimeEquals(pending.code, code.trim())) {
    return { ok: false, reason: 'mismatch' };
  }

  const paired = new Set(extra.pairedChatIds ?? []);
  paired.add(chatId);

  state.extra = { ...extra, pairedChatIds: [...paired], pendingPairing: undefined };
  await writeAdapterState(projectRoot, 'telegram', state);

  return { ok: true, chatId };
}

/**
 * Length-independent comparison that does not short-circuit on the first
 * differing digit, so response time does not leak how much of the code was right.
 */
function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function getPairedChatIds(projectRoot: string): Promise<number[]> {
  const state = await readAdapterState(projectRoot, 'telegram');
  return ((state.extra ?? {}) as TelegramExtra).pairedChatIds ?? [];
}

export async function unpairChat(projectRoot: string, chatId: number): Promise<boolean> {
  const state = await readAdapterState(projectRoot, 'telegram');
  const extra = (state.extra ?? {}) as TelegramExtra;
  const paired = new Set(extra.pairedChatIds ?? []);

  if (!paired.delete(chatId)) return false;

  state.extra = { ...extra, pairedChatIds: [...paired] };
  await writeAdapterState(projectRoot, 'telegram', state);
  return true;
}

/**
 * Whether a chat may issue commands.
 *
 * Fails closed: with no configured ids and no pairings, nothing is authorized.
 * An empty allowlist meaning "allow everyone" is the kind of default that turns
 * a leaked token into a compromised repository.
 */
export function isAuthorized(
  chatId: number,
  configuredIds: number[],
  pairedIds: number[]
): boolean {
  return configuredIds.includes(chatId) || pairedIds.includes(chatId);
}
