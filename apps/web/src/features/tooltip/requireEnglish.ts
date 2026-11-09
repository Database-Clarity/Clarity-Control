/**
 * Whether the editor reports empty English as an error. Saving ignores unwritten English on a
 * tooltip whose English is untouched, so the editor shows the error only once the English text
 * is edited to blank. Written English is always required, which keeps the flag constant while
 * typing there (the editor reconfigures when it changes); over an unwritten English it follows
 * blank, edited text. Reserved global documents (hash 3 or below) never need English.
 */
export function requireEnglish(hash: number, lang: string, saved: string, text: string): boolean {
  if (hash <= 3) return false;
  if (lang !== 'en' || saved.trim()) return true;
  return text !== saved && !text.trim();
}
