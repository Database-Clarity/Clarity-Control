// @vitest-environment jsdom
import { act, createContext, useContext, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellSlot, ShellSlotHost, ShellSlotsProvider } from './ShellSlots';

let host: HTMLDivElement;
let root: Root;
const Theme = createContext('none');
const slot = (name: string) => host.querySelector(`[data-shell-slot="${name}"]`)!;

function Layout({ children }: { children?: React.ReactNode }) {
  return (
    <ShellSlotsProvider>
      <ShellSlotHost name="left" />
      <ShellSlotHost name="finder" />
      <main>{children}</main>
    </ShellSlotsProvider>
  );
}
function Echo() {
  return <span>{useContext(Theme)}</span>;
}
function show(node: React.ReactNode) {
  act(() => root.render(<Layout>{node}</Layout>));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('shell slots', () => {
  it('renders a route’s slot content inside the Layout’s host, not where it was written', () => {
    show(
      <section>
        <ShellSlot name="left">Preview column</ShellSlot>
        Page body
      </section>,
    );
    expect(slot('left').textContent).toBe('Preview column');
    expect(host.querySelector('main')!.textContent).toBe('Page body');
    expect(slot('finder').textContent).toBe('');
  });

  it('keeps the publisher’s own context and state: one subtree, never a second copy', () => {
    let mounts = 0;
    function Counter() {
      const [count, setCount] = useState(() => ++mounts);
      return (
        <button type="button" onClick={() => setCount(count + 10)}>
          {count}
        </button>
      );
    }
    show(
      <Theme.Provider value="dark">
        <ShellSlot name="left">
          <Echo />
          <Counter />
        </ShellSlot>
      </Theme.Provider>,
    );
    expect(slot('left').textContent).toBe('dark1');
    act(() => slot('left').querySelector('button')!.click());
    expect(slot('left').textContent).toBe('dark11');
    show(
      <Theme.Provider value="light">
        <ShellSlot name="left">
          <Echo />
          <Counter />
        </ShellSlot>
      </Theme.Provider>,
    );
    expect(slot('left').textContent).toBe('light11');
    expect(mounts).toBe(1);
  });

  it('empties the slot when its route unmounts', () => {
    show(<ShellSlot name="left">Route A</ShellSlot>);
    show(<p>No publisher</p>);
    expect(slot('left').textContent).toBe('');
  });

  it('lets the newest route own a slot, and a route leaving late cannot clear it', () => {
    function Routes({ a, b }: { a: boolean; b: boolean }) {
      return (
        <>
          {a && <ShellSlot name="left">Route A</ShellSlot>}
          {b && <ShellSlot name="left">Route B</ShellSlot>}
        </>
      );
    }
    show(<Routes a b={false} />);
    expect(slot('left').textContent).toBe('Route A');
    // B arrives while A has not unmounted yet: B owns the slot and A renders nothing.
    show(<Routes a b />);
    expect(slot('left').textContent).toBe('Route B');
    // A's late cleanup finds it is no longer the owner.
    show(<Routes a={false} b />);
    expect(slot('left').textContent).toBe('Route B');
    show(<Routes a={false} b={false} />);
    expect(slot('left').textContent).toBe('');
  });

  it('keeps separate slots independent and survives a strict-mode style remount', () => {
    show(
      <>
        <ShellSlot name="left">Left</ShellSlot>
        <ShellSlot name="finder">Finder</ShellSlot>
      </>,
    );
    expect(slot('left').textContent).toBe('Left');
    expect(slot('finder').textContent).toBe('Finder');
    show(<ShellSlot name="finder">Finder</ShellSlot>);
    expect(slot('left').textContent).toBe('');
    expect(slot('finder').textContent).toBe('Finder');
  });

  it('refuses to be used outside a Layout', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => act(() => root.render(<ShellSlot name="left">x</ShellSlot>))).toThrow('Layout');
    error.mockRestore();
    root = createRoot(host);
  });
});
