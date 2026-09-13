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
  // Working keeps the resting face: the engine's alert state paints the body
  // gray, which reads as the avatar dying mid-task. Only typing morphs.
  idle: 'idle',
  typing: 'thinking',
  working: 'idle',
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
