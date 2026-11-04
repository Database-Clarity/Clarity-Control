import type { ComponentType } from 'react';

let loaded: ComponentType | undefined;

export function loadedReviewPage() {
  return loaded;
}

export function rememberReviewPage(component: ComponentType | undefined) {
  loaded = component;
}
