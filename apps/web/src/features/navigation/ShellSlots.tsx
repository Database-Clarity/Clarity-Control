import {
  createContext,
  useContext,
  useCallback,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Places the Layout owns and route components fill: the workspace finder, the left column content,
 * the page identity and the status line. A route renders `<ShellSlot name="left">…</ShellSlot>`
 * and its children appear inside the Layout's `<ShellSlotHost name="left" />`.
 *
 * The children are portalled, so they stay one React subtree of the route that published them
 * (same hooks, context, state), never a second copy; the Layout only provides the place. Each
 * slot has one owner at a time. A route claims the slot when it mounts and gives it up when it
 * unmounts, and only the current owner may give it up, so a route that is leaving late can
 * never clear what the route arriving after it has already published.
 */
export type SlotName = 'finder' | 'left' | 'identity' | 'status';

interface Claim {
  owner: symbol;
}

function createSlots() {
  const targets = new Map<SlotName, HTMLElement>();
  const claims = new Map<SlotName, Claim>();
  const listeners = new Set<() => void>();
  let version = 0;
  const emit = () => {
    version++;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    version: () => version,
    target: (name: SlotName) => targets.get(name),
    owner: (name: SlotName) => claims.get(name)?.owner,
    setTarget(name: SlotName, element: HTMLElement | null) {
      if ((targets.get(name) ?? null) === element) return;
      if (element) targets.set(name, element);
      else targets.delete(name);
      emit();
    },
    claim(name: SlotName, owner: symbol) {
      claims.set(name, { owner });
      emit();
    },
    release(name: SlotName, owner: symbol) {
      if (claims.get(name)?.owner !== owner) return;
      claims.delete(name);
      emit();
    },
  };
}
type Slots = ReturnType<typeof createSlots>;

const SlotsContext = createContext<Slots | null>(null);

export function ShellSlotsProvider({ children }: { children: ReactNode }) {
  const [slots] = useState(createSlots);
  return <SlotsContext.Provider value={slots}>{children}</SlotsContext.Provider>;
}

function useSlots(): Slots {
  const slots = useContext(SlotsContext);
  if (!slots) throw new Error('Shell slots are only available inside the Layout.');
  return slots;
}

/** Where a slot's content appears. Rendered by the Layout, once per slot. */
export function ShellSlotHost({
  name,
  ...props
}: { name: SlotName } & HTMLAttributes<HTMLDivElement>) {
  const slots = useSlots();
  const attach = useCallback(
    (element: HTMLDivElement | null) => slots.setTarget(name, element),
    [slots, name],
  );
  return <div {...props} data-shell-slot={name} ref={attach} />;
}

/** Publishes `children` into the named slot for as long as this component is mounted and owns it. */
export function ShellSlot({ name, children }: { name: SlotName; children: ReactNode }) {
  const slots = useSlots();
  const [owner] = useState(() => Symbol(name));
  useLayoutEffect(() => {
    slots.claim(name, owner);
    return () => {
      slots.release(name, owner);
    };
  }, [slots, name, owner]);
  // Re-render when the target element or the owner changes.
  useSyncExternalStore(slots.subscribe, slots.version, slots.version);
  const target = slots.target(name);
  if (!target || slots.owner(name) !== owner) return null;
  return createPortal(children, target);
}
