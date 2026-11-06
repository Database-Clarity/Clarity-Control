// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDataStore, type EditorData } from '../../stores/data';
import { usePreviewReviewStore } from '../../stores/previewReview';
import { useAcknowledgePreview } from '../navigation/useAcknowledgePreview';
import { previewedHashes, type PreviewMode } from './previewMode';

/** The page's acknowledgement for one rendered variant (TooltipPage's PreviewAck). */
function Ack({ variant, visible }: { variant: number; visible: boolean }) {
  useAcknowledgePreview(variant, visible);
  return null;
}
function Page({
  mode,
  collapsed,
  enhanced,
}: {
  mode: PreviewMode;
  collapsed: boolean;
  enhanced: { hash: number; derived: boolean } | undefined;
}) {
  return (
    <>
      {previewedHashes(mode, 10, enhanced).map((variant) => (
        <Ack key={variant} variant={variant} visible={!collapsed} />
      ))}
    </>
  );
}

let host: HTMLDivElement;
let root: Root;
let stopHost: () => void;
const override = { hash: 12, derived: false };
const derived = { hash: 11, derived: true };
const blocked = () => usePreviewReviewStore.getState().leaveBlocked('/t/10', '/review');
const edited = (...variants: number[]) =>
  usePreviewReviewStore.setState({
    scope: 'anonymous',
    entries: Object.fromEntries(
      variants.map((variant) => [variant, { canonical: 10, dirty: 1, reviewed: 0 }]),
    ),
  });
function render(
  mode: PreviewMode,
  collapsed: boolean,
  enhanced: { hash: number; derived: boolean } | undefined = override,
) {
  act(() => root.render(<Page mode={mode} collapsed={collapsed} enhanced={enhanced} />));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query }),
  });
  useDataStore.setState({
    data: {
      items: {
        10: { hash: 10, name: 'Perk', categoryId: 'a', icon: '', enhancedHashes: [11, 12] },
      },
      aliases: {},
      categories: [],
      bundle: { tooltips: {}, sourceCommit: 'abc' },
    } as unknown as EditorData,
  });
  usePreviewReviewStore.setState({ scope: null, entries: {}, prompt: null, host: null });
  stopHost = usePreviewReviewStore.getState().registerHost({ show: () => undefined });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  stopHost();
  delete (window as { matchMedia?: unknown }).matchMedia;
  vi.unstubAllGlobals();
});

describe('leaving an edited item while the preview is open', () => {
  it.each<PreviewMode>(['base', 'compare'])('%s shows an edit to the base text', (mode) => {
    edited(10);
    expect(blocked()).toBe(true);
    render(mode, false);
    expect(blocked()).toBe(false);
  });

  it('Enhanced shows an edit to the override it displays', () => {
    edited(12);
    render('enhanced', false);
    expect(blocked()).toBe(false);
  });

  it('Enhanced of a derived version shows the base text', () => {
    edited(10);
    render('enhanced', false, derived);
    expect(blocked()).toBe(false);
  });

  it('Compare shows an edit to the override it compares against the base', () => {
    edited(12);
    render('compare', false);
    expect(blocked()).toBe(false);
  });

  it('Compare counts edits to the base and the override together', () => {
    edited(10, 12);
    render('compare', false);
    expect(usePreviewReviewStore.getState().unreviewed(10)).toEqual([]);
    expect(blocked()).toBe(false);
  });

  it('counts an edit made while the view is already showing', () => {
    render('compare', false);
    edited(10);
    // The store entry arrives after the view mounted; the next commit sees it.
    render('compare', false);
    expect(blocked()).toBe(false);
  });

  it('still asks when the preview is collapsed, in every view', () => {
    for (const mode of ['base', 'enhanced', 'compare'] as const) {
      edited(10, 12);
      render(mode, true);
      expect(blocked()).toBe(true);
    }
  });

  it('still asks for an override edit when Base is showing', () => {
    edited(12);
    render('base', false);
    expect(blocked()).toBe(true);
  });
});
