/**
 * Public surface of the integrations layer.
 *
 * Everything integration-related lives under this directory so the fork's diff
 * against upstream stays confined to a handful of registration lines elsewhere —
 * OpenSpec releases often, and a rebase should not have to re-litigate this code.
 */

export * from './types.js';
export * from './config.js';
export * from './secrets.js';
export * from './state.js';
export * from './events.js';
export * from './snapshot.js';
export * from './task-writer.js';
export * from './registry.js';
export * from './watcher.js';
