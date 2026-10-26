// apps/web/src/lib/setup-commands.ts
// Setup commands as a form: one card per command, kept as typed. Shared by
// the agent config dialogs, which write the same field and must not drift
// apart in how they read it (the arrangement lib/credentials.ts has).

/**
 * The cards as setup commands — or nothing while a card is blank: a blank
 * command isn't one yet, so a form waits for it rather than sending it.
 * Each command goes as typed, line breaks and all (a heredoc writes a
 * file); what else a command may hold is the api's to judge.
 */
export function toSetupCommands(cards: string[]): string[] | undefined {
  return cards.every((card) => /\S/.test(card)) ? cards : undefined;
}

/** Whether two lists say the same thing, command for command and in
 *  order. What an edit compares against to know whether there is anything
 *  to save. */
export function sameSetupCommands(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((command, i) => command === b[i]);
}
