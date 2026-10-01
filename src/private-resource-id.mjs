// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from 'node:crypto';

// Identifies a path in the selected owner-local recovery view, not an upstream
// account or sharing authority. No names or identifiers are published to peers.
export function recoveryResourceId(parts) {
  if (!Array.isArray(parts) || parts.length > 32 || !parts.every(value =>
    typeof value === 'string' && value.length > 0 && value.length <= 1024
      && !['.', '..'].includes(value) && !/[\\/\x00-\x1f\x7f]/u.test(value))) {
    throw new Error('Invalid private resource path');
  }
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return `vp-recovery-${digest(parts.slice(0, 1))}!${digest(parts)}`;
}

export const isRecoveryResourceId = value => typeof value === 'string'
  && /^vp-recovery-[a-f0-9]{64}![a-f0-9]{64}$/u.test(value);

export const recoverySpaceId = name => recoveryResourceId([name]).split('!')[0];
export const isRecoverySpaceId = value => typeof value === 'string'
  && /^vp-recovery-[a-f0-9]{64}$/u.test(value);
