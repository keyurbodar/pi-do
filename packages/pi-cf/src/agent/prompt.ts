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

export function composePrompt(base: string): string {
  const parts = [base];
  for (const section of sections) parts.push(`## ${section.heading}\n${section.body}`);
  for (const snippet of snippets) parts.push(snippet);
  return parts.join("\n\n");
}
