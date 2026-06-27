// The single uppercase letter shown in an agent's pixel avatar (F, P, L, …).
export function avatarLetter(name: string): string {
  const ch = name.trim()[0];
  return ch ? ch.toUpperCase() : "?";
}
