export interface PromptSection {
  heading: string;
  body: string;
}

const sections: PromptSection[] = [];
const snippets: string[] = [];

export function registerPromptSection(heading: string, body: string): void {
  sections.push({ heading, body });
}

export function registerPromptSnippet(text: string): void {
  snippets.push(text);
}

// extras is the per-session persona (bot backstory): data passed at call
// time, deliberately not a registry entry, so two sessions in one process
// compose different prompts.
export function composePrompt(base: string, extras?: string): string {
  const parts = [base];
  for (const section of sections) parts.push(`## ${section.heading}\n${section.body}`);
  for (const snippet of snippets) parts.push(snippet);
  if (extras !== undefined && extras.length > 0) parts.push(extras);
  return parts.join("\n\n");
}
