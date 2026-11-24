// The page's server state: the notes, and one audit at a time. TanStack Query holds it, and every
// change the page makes is a mutation that stays pending until the reload after it ends.

import { QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import * as api from "./api";

const POLL_MS = 3000;

export const queryClient = new QueryClient({
  defaultOptions: {
    // The store is on this machine: an error is real, so show it at once. The poll below sees
    // outside changes, so a focus does not need to reload.
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

export const pageQuery = queryOptions({ queryKey: ["page"], queryFn: api.loadPage });

/** The audit is dropped when its page closes, so the next visit shows the proposal as it is then. */
export const auditQuery = (scope: string) => queryOptions({ queryKey: ["audit", scope], queryFn: () => api.loadAudit(scope), gcTime: 0 });

/** Reload the notes. The promise ends when the new notes are in. */
export const reloadPage = () => queryClient.invalidateQueries({ queryKey: pageQuery.queryKey });

/**
 * A note that an agent adds or changes shows without a reload. A cheap version check runs while
 * the tab shows, and the notes reload when the store moved. It skips a turn while a change from
 * this page is on its way, as that change reloads the notes itself. Its error says that the server
 * is down, and its `write` says whether the page has the key to change notes.
 */
export function useStoreWatch() {
  return useQuery({
    queryKey: ["store-state"],
    refetchInterval: POLL_MS,
    // The poll goes on after an error, so the page comes back when the server does.
    queryFn: async () => {
      const state = await api.storeState();
      const page = queryClient.getQueryState(pageQuery.queryKey);
      // A page that could not load at first, or that changed, loads again.
      const stale = !page?.data || state.version !== page.data.version;
      if (stale && page?.fetchStatus !== "fetching" && queryClient.isMutating() === 0) await reloadPage();
      return state;
    },
  });
}
