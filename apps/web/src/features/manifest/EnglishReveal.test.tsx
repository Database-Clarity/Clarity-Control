// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { EnglishReveal } from './EnglishReveal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

it('is plain text in English, even for an ellipsised name', () => {
  const host = render(
    <EnglishReveal english="The Fundamentals" translated={undefined} lang="en" showTranslation />,
  );
  expect(host.innerHTML).toBe('The Fundamentals');
});

it('is plain text when the translation equals the English name', () => {
  const host = render(
    <EnglishReveal english="Thunderlord" translated="Thunderlord" lang="fr" showTranslation />,
  );
  expect(host.innerHTML).toBe('Thunderlord');
});

it('reveals the English original of a localised name', () => {
  const host = render(
    <EnglishReveal english="The Fundamentals" translated="Les fondamentaux" lang="fr" />,
  );
  const trigger = host.querySelector('button')!;
  expect(trigger.textContent).toBe('Les fondamentaux');
  expect(trigger.getAttribute('aria-label')).toBe('Les fondamentaux — show English original');
});
