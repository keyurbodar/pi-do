// components/chat — akeru-style timeline. ThreadPane is the drop-in
// replacement for thread/Thread (same props plus avatarSlot); mapper.ts is
// the pure TurnViewState → ThreadItemVM mapping.
export { ThreadPane } from "./ThreadPane";
export { useFixturePlayback } from "./useFixturePlayback";
export { useApprovalDecision } from "./useApprovalDecision";
export {
  turnToItems,
  type ChatItemVM,
  type DelegationVM,
  type SenderMessageBubbleVM,
  type ThinkingRowVM,
  type UserInputVM,
} from "./mapper";
export { MessageBubble } from "./MessageBubble";
export { StatusCard } from "./StatusCard";
export { ThinkingRow } from "./ThinkingRow";
export { InterBotDivider } from "./InterBotDivider";
export { BotMention } from "./BotMention";
export { ApprovalCard } from "./ApprovalCard";
export { DelegationCard } from "./DelegationCard";
export { UserInputCard } from "./UserInputCard";
export { StepMeter, stepLabel } from "./StepMeter";
export { ChatHeader } from "./ChatHeader";
export { ActivityRow } from "./ActivityRow";
export { Lightbox } from "./Lightbox";
export { buildTranscript } from "./transcript";
export type { FixtureSegment } from "./fixtureScripts";
