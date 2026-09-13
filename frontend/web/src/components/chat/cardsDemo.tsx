// components/chat/cardsDemo.tsx — fixture/demo export rendering one of each
// grok-style card. The orchestrator wires real turn metadata later; this
// export exists so fixtures and demos can mount every card without a backend.
import { AgentCard } from "./AgentCard";
import { ChoiceWidget } from "./ChoiceWidget";
import { CodeBlock } from "./CodeBlock";
import { FileCard } from "./FileCard";
import { SecretCard } from "./SecretCard";

export function CardsDemo() {
  return (
    <div data-testid="cards-demo" className="flex flex-col items-start gap-3">
      <FileCard name="report.pdf" size="1.2 MB" />
      <CodeBlock code={'const hello = "world";'} language="ts" />
      <ChoiceWidget title="Pick a plan" subtitle="Choose how to proceed" />
      <SecretCard />
      <AgentCard name="Research agent" task="Pulling the account list" status="running" />
    </div>
  );
}
