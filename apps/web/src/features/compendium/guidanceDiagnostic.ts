import { errorMessage } from '../../services/http';

/** Never expose HTML response bodies or unbounded schema/network diagnostics. */
export function guidanceDiagnostic(error: unknown): string {
  return errorMessage(error)
    .replace(/<[^>]*>/g, ' ')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
