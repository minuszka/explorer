import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AUTO_REFRESH_MS } from '../queryClient';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { createRefreshQueue, type RefreshKeys } from '../utils/refreshQueue';
import type { DashboardOverviewView, StatsView } from '../types/api';
import type {
  RealtimeServerEvent,
  RealtimeServerEventType,
  WsSyncStatusPayload,
} from '../types/realtime';

const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 15_000;
// The open transaction, block and address pages. A key matches every query that starts with it,
// and only the queries of the page on screen are asked again ('active').
const DETAIL_PAGE_QUERY_KEYS: ReadonlyArray<ReadonlyArray<unknown>> = [
  ['tx'],
  ['block'],
  ['block-txs'],
  ['address'],
  ['address-txs'],
];
const BLOCK_EVENT_REFRESH_QUERY_KEYS: ReadonlyArray<ReadonlyArray<unknown>> = [
  ['dashboard-overview'],
  ['stats'],
  ['blocks-cursor'],
  ['txs-cursor'],
  ...DETAIL_PAGE_QUERY_KEYS,
];
const TX_EVENT_REFRESH_QUERY_KEYS: ReadonlyArray<ReadonlyArray<unknown>> = [
  ['dashboard-overview'],
  ['txs-cursor'],
  ['mempool'],
];
const TERMINAL_SYNC_REFRESH_QUERY_KEYS: ReadonlyArray<ReadonlyArray<unknown>> = [
  ['dashboard-overview'],
  ['stats'],
  ['blocks-cursor'],
  ['txs-cursor'],
  ['mempool'],
  ...DETAIL_PAGE_QUERY_KEYS,
];

const POLL_REFRESH_QUERY_KEYS = TERMINAL_SYNC_REFRESH_QUERY_KEYS;

type AutoRefreshContextValue = {
  realtimeConnected: boolean;
  transportMode: 'websocket' | 'polling';
};

const AutoRefreshContext = createContext<AutoRefreshContextValue | null>(null);

const SERVER_EVENT_TYPES: RealtimeServerEventType[] = ['hello', 'pong', 'sync:status', 'block:new', 'tx:new', 'error'];

function isRealtimeEventType(value: string): value is RealtimeServerEventType {
  return (SERVER_EVENT_TYPES as string[]).includes(value);
}

function resolveRealtimeWsUrl(): string {
  const apiBase = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
  const fallbackProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const fallback = `${fallbackProtocol}//${window.location.host}/ws`;

  if (!apiBase) return fallback;

  try {
    const url = new URL(apiBase, window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return fallback;
  }
}

function parseRealtimeEvent(raw: string): RealtimeServerEvent | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; ts?: unknown; seq?: unknown; data?: unknown };
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.type !== 'string' || !isRealtimeEventType(parsed.type)) return null;
    if (typeof parsed.ts !== 'string') return null;
    if (parsed.seq != null) {
      if (typeof parsed.seq !== 'number' || !Number.isFinite(parsed.seq)) return null;
      if (parsed.seq < 1) return null;
    }
    return parsed as RealtimeServerEvent;
  } catch {
    return null;
  }
}

function isSyncRunningState(state: WsSyncStatusPayload['state']): boolean {
  return state === 'started' || state === 'syncing';
}

function applySyncToDashboard(
  current: DashboardOverviewView | undefined,
  payload: WsSyncStatusPayload
): DashboardOverviewView | undefined {
  if (!current) return current;
  return {
    ...current,
    sync: {
      ...current.sync,
      isRunning: isSyncRunningState(payload.state),
      daemonHeight: payload.daemonHeight,
      lastSyncedHeight: payload.lastSyncedHeight,
      blocksRemaining: payload.blocksRemaining,
      progress: payload.progress,
      error: payload.error ?? null,
    },
  };
}

function applyBlockToStats(
  current: StatsView,
  payload: { height: number; time: number }
): StatsView {
  const blockHeight = Math.max(current.blockHeight, payload.height);
  const lastBlockTime = current.lastBlockTime == null ? payload.time : Math.max(current.lastBlockTime, payload.time);
  if (blockHeight === current.blockHeight && lastBlockTime === current.lastBlockTime) return current;

  return { ...current, blockHeight, lastBlockTime };
}

export function AutoRefreshProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const isPageVisible = usePageVisibility();
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const lastRealtimeSeqRef = useRef<number | null>(null);

  const setKnownLastBlock = useCallback(
    (next: { height: number; time: number }) => {
      queryClient.setQueryData<DashboardOverviewView | undefined>(['dashboard-overview'], (current) => {
        if (!current || !current.stats) return current;
        return {
          ...current,
          stats: applyBlockToStats(current.stats, next),
        };
      });
      queryClient.setQueryData<StatsView | undefined>(['stats'], (current) =>
        current ? applyBlockToStats(current, next) : current
      );
    },
    [queryClient]
  );

  const refreshQueue = useMemo(() => createRefreshQueue((keys) => Promise.allSettled(
    keys.map((queryKey) => queryClient.refetchQueries({ queryKey, type: 'active' }))
  )), [queryClient]);

  useEffect(() => {
    refreshQueue.setActive(isPageVisible);
    return () => refreshQueue.setActive(false);
  }, [isPageVisible, refreshQueue]);

  const runRefresh = useCallback((keys: RefreshKeys = POLL_REFRESH_QUERY_KEYS) => {
    refreshQueue.enqueue(keys, 'immediate');
  }, [refreshQueue]);

  const scheduleRealtimeRefresh = useCallback((
    priority: 'normal' | 'high' = 'normal',
    keys: RefreshKeys = POLL_REFRESH_QUERY_KEYS
  ) => {
    refreshQueue.enqueue(keys, priority);
  }, [refreshQueue]);

  useEffect(() => {
    if (!isPageVisible) return;
    void runRefresh(POLL_REFRESH_QUERY_KEYS);
  }, [isPageVisible, runRefresh]);

  useEffect(() => {
    if (!isPageVisible || realtimeConnected) return;
    const interval = window.setInterval(() => {
      void runRefresh(POLL_REFRESH_QUERY_KEYS);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [isPageVisible, realtimeConnected, runRefresh]);

  useEffect(() => {
    if (!isPageVisible) {
      setRealtimeConnected(false);
      return;
    }

    let socket: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const clearReconnectTimer = () => {
      if (reconnectTimer != null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer != null) return;
      const delay = Math.min(WS_RECONNECT_BASE_MS * 2 ** reconnectAttempt, WS_RECONNECT_MAX_MS);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;
      const wsUrl = resolveRealtimeWsUrl();

      try {
        socket = new WebSocket(wsUrl);
      } catch {
        setRealtimeConnected(false);
        scheduleReconnect();
        return;
      }

      socket.onopen = () => {
        reconnectAttempt = 0;
        lastRealtimeSeqRef.current = null;
        setRealtimeConnected(true);
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const parsed = parseRealtimeEvent(event.data);
        if (!parsed) return;

        if (typeof parsed.seq === 'number') {
          const previousSeq = lastRealtimeSeqRef.current;
          if (previousSeq != null) {
            if (parsed.seq > previousSeq + 1 || parsed.seq <= previousSeq) {
              scheduleRealtimeRefresh('high', TERMINAL_SYNC_REFRESH_QUERY_KEYS);
            }
          }
          lastRealtimeSeqRef.current = parsed.seq;
        }

        if (parsed.type === 'block:new') {
          if (typeof parsed.data?.time === 'number') {
            setKnownLastBlock({ height: parsed.data.height, time: parsed.data.time });
          }
          scheduleRealtimeRefresh('normal', BLOCK_EVENT_REFRESH_QUERY_KEYS);
          return;
        }

        if (parsed.type === 'tx:new') {
          scheduleRealtimeRefresh('normal', TX_EVENT_REFRESH_QUERY_KEYS);
          return;
        }

        if (parsed.type === 'sync:status') {
          queryClient.setQueryData<DashboardOverviewView | undefined>(['dashboard-overview'], (current) =>
            applySyncToDashboard(current, parsed.data)
          );

          if (parsed.data.state === 'complete' || parsed.data.state === 'idle' || parsed.data.state === 'error') {
            scheduleRealtimeRefresh('high', TERMINAL_SYNC_REFRESH_QUERY_KEYS);
          }
          return;
        }

        if (parsed.type === 'error') {
          scheduleRealtimeRefresh('high', TERMINAL_SYNC_REFRESH_QUERY_KEYS);
        }
      };

      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          // ignore
        }
      };

      socket.onclose = () => {
        setRealtimeConnected(false);
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      lastRealtimeSeqRef.current = null;
      setRealtimeConnected(false);
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
    };
  }, [isPageVisible, queryClient, scheduleRealtimeRefresh, setKnownLastBlock]);

  const value = useMemo<AutoRefreshContextValue>(
    () => ({
      realtimeConnected,
      transportMode: realtimeConnected ? 'websocket' : 'polling',
    }),
    [realtimeConnected]
  );

  return <AutoRefreshContext.Provider value={value}>{children}</AutoRefreshContext.Provider>;
}

export function useAutoRefresh(): AutoRefreshContextValue {
  const context = useContext(AutoRefreshContext);
  if (!context) {
    throw new Error('useAutoRefresh must be used within AutoRefreshProvider');
  }
  return context;
}
