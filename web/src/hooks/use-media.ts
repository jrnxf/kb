import { useSyncExternalStore } from "react";

const lists = new Map<string, MediaQueryList>();
const list = (query: string) => lists.get(query) ?? lists.set(query, matchMedia(query)).get(query)!;
const subscribers = new Map<string, (change: () => void) => () => void>();
const subscriber = (query: string) =>
  subscribers.get(query) ??
  subscribers.set(query, (change) => (list(query).addEventListener("change", change), () => list(query).removeEventListener("change", change))).get(query)!;

export function useMedia(query: string): boolean {
  return useSyncExternalStore(subscriber(query), () => list(query).matches);
}

/** A narrow screen: the note opens in a drawer. */
export const PHONE = "(max-width: 900px)";
/** A screen without a keyboard does not show the keys. */
export const TOUCH = "(hover: none) and (pointer: coarse)";
export const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
