// Pure presentation: maps a roster bot's identity + presence onto the bloub
// engine. Deterministic per-bot variation lives in the roster fixtures, not
// here.
import Bloub, { type BloubState } from './Bloub';
import type { BloubIdentity, BotPresence } from '../../lib/roster';

export interface BotAvatarProps {
  identity: BloubIdentity;
  size?: number;
  presence?: BotPresence;
  className?: string;
}

const STATE_BY_PRESENCE: Record<BotPresence, BloubState> = {
  idle: 'idle',
  typing: 'thinking',
  working: 'alert',
  sleeping: 'sleep',
};

export default function BotAvatar({
  identity,
  size = 40,
  presence = 'idle',
  className,
}: BotAvatarProps) {
  return (
    <Bloub
      state={STATE_BY_PRESENCE[presence]}
      shape={identity.shape}
      color={identity.color}
      expression={identity.expression}
      size={size}
      className={className}
    />
  );
}
