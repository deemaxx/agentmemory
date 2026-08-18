import type { ISdk } from 'iii-sdk'
import { getEnvVar } from '../config.js'

// Worker-wide invocationTimeoutMs is 180000ms (src/index.ts), sized for
// LLM-backed functions like mem::graph-extract's provider.compress() call,
// which legitimately needs that much slack for slow local models. Plain KV
// round-trips share no such excuse — a healthy state::get/state::set is a
// local file-backed read/write and should return in well under a second.
// Before this fix, every StateKV call inherited the full 180s worker default
// via iii-sdk's per-call `timeoutMs` override (unused, defaulting through),
// so a single stalled KV call (contention, a stuck file_based adapter) could
// silently block for up to 3 minutes with zero visibility. Functions that
// issue many sequential KV calls per invocation — mem::graph-extract does up
// to 19 — had no per-call signal to distinguish "this one call is stuck" from
// "the LLM is just slow," and the eventual failure surfaced as an opaque
// "Invocation timeout after 180000ms: mem::graph-extract" with no indication
// the actual stall was in a KV call, not the LLM call (see #1127). A short,
// KV-specific timeoutMs makes a stuck call fail fast and attributably
// (function_id + scope/key in the resulting error) instead of silently
// consuming the same 180s budget reserved for LLM work.
//
// AGENTMEMORY_KV_TIMEOUT_MS overrides the default below the 180s worker
// ceiling. The default (10s) targets the file_based adapter; a
// network-backed state adapter can raise it without a code change.
//
// Strict-digits parse (not plain Number.parseInt), matching
// parsePositiveInt in src/providers/openai.ts (#446): parseInt would
// silently accept "30ms" or "1_000" as 30 / 1, swallowing a typo as a
// valid — and possibly dangerously small — timeout instead of falling
// back to the default.
const DEFAULT_KV_TIMEOUT_MS = 10_000
const KV_TIMEOUT_MS = resolveKvTimeoutMs()

function resolveKvTimeoutMs(): number {
  const raw = getEnvVar('AGENTMEMORY_KV_TIMEOUT_MS')
  if (raw === undefined) return DEFAULT_KV_TIMEOUT_MS
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return DEFAULT_KV_TIMEOUT_MS
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_KV_TIMEOUT_MS
}

export class StateKV {
  constructor(private sdk: ISdk) {}

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    return this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: 'state::get',
      payload: { scope, key },
      timeoutMs: KV_TIMEOUT_MS,
    })
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: 'state::set',
      payload: { scope, key, value },
      timeoutMs: KV_TIMEOUT_MS,
    })
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    return this.sdk.trigger<
      { scope: string; key: string; ops: Array<{ type: string; path: string; value?: unknown }> },
      T
    >({
      function_id: 'state::update',
      payload: { scope, key, ops },
      timeoutMs: KV_TIMEOUT_MS,
    })
  }

  async delete(scope: string, key: string): Promise<void> {
    return this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: 'state::delete',
      payload: { scope, key },
      timeoutMs: KV_TIMEOUT_MS,
    })
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    return this.sdk.trigger<{ scope: string }, T[]>({
      function_id: 'state::list',
      payload: { scope },
      timeoutMs: KV_TIMEOUT_MS,
    })
  }
}
