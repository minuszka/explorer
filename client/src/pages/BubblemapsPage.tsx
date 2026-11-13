import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import ForceGraph2D from 'react-force-graph-2d';
import {
  HiOutlineMagnifyingGlass,
  HiOutlineShare,
  HiOutlineArrowPath,
  HiOutlineArrowsPointingOut,
} from 'react-icons/hi2';
import type {
  AddressGraphEdgeView,
  AddressGraphNodeView,
} from '../types/api';
import { fetchAddressGraph } from '../services/api';
import { formatCoin, formatNumber, truncateHash, formatAge } from '../utils/formatters';
import './BubblemapsPage.css';

type GraphNode = AddressGraphNodeView & {
  x?: number;
  y?: number;
};

type GraphLink = Omit<AddressGraphEdgeView, 'source' | 'target'> & {
  source: string | GraphNode;
  target: string | GraphNode;
};

const GROUP_COLORS = [
  '#2f8fff',
  '#00d4ff',
  '#ff50ce',
  '#f4d029',
  '#7d66ff',
  '#27d17f',
  '#ff9e3d',
  '#66c2ff',
  '#36f0c5',
  '#d483ff',
];

const NODE_LIMIT_OPTIONS = [80, 120, 160, 220];

function looksLikeAddress(input: string): boolean {
  const normalized = input.trim();
  return normalized.length >= 26 && normalized.length <= 35 && /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(normalized);
}

function resolveNodeColor(node: GraphNode): string {
  if (node.isRoot) return '#7ab9ff';
  return GROUP_COLORS[Math.abs(node.group) % GROUP_COLORS.length];
}

function resolveNodeSize(node: GraphNode): number {
  if (node.isRoot) return 11;
  const balance = Math.max(node.balance, 0);
  const scaled = Math.sqrt(balance + 1) * 0.72;
  return Math.max(3, Math.min(13, scaled));
}

export default function BubblemapsPage() {
  const graphRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [graphSize, setGraphSize] = useState({ width: 800, height: 600 });
  const [searchParams, setSearchParams] = useSearchParams();

  const initialAddress = searchParams.get('address') || '';
  const initialDepth = Math.min(3, Math.max(1, Number(searchParams.get('depth') || 2)));
  const initialNodes = Math.min(220, Math.max(80, Number(searchParams.get('maxNodes') || 120)));

  const [addressInput, setAddressInput] = useState(initialAddress);
  const [depthInput, setDepthInput] = useState(initialDepth);
  const [maxNodesInput, setMaxNodesInput] = useState(initialNodes);
  const [queryAddress, setQueryAddress] = useState(initialAddress);
  const [queryDepth, setQueryDepth] = useState(initialDepth);
  const [queryMaxNodes, setQueryMaxNodes] = useState(initialNodes);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialAddress || null);

  const queryEnabled = looksLikeAddress(queryAddress);
  const graphQuery = useQuery({
    queryKey: ['address-graph', queryAddress, queryDepth, queryMaxNodes],
    queryFn: () =>
      fetchAddressGraph(queryAddress, {
        depth: queryDepth,
        maxNodes: queryMaxNodes,
      }),
    enabled: queryEnabled,
    staleTime: 30_000,
  });

  const rawNodes = graphQuery.data?.nodes;
  const rawLinks = graphQuery.data?.edges;
  const graphData = useMemo(() => {
    const nodes = (rawNodes || []).map((node) => ({ ...node })) as GraphNode[];
    const links = (rawLinks || []).map((edge) => ({ ...edge })) as GraphLink[];
    return { nodes, links };
  }, [rawNodes, rawLinks]);

  const nodeMap = useMemo(() => {
    return new Map(graphData.nodes.map((node) => [node.id, node]));
  }, [graphData.nodes]);

  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) : null;
  const rootNode = graphData.nodes.find((node) => node.isRoot) || null;

  const connectedLinks = useMemo<GraphLink[]>(() => {
    if (!selectedNode) return [];
    return graphData.links
      .filter((link) => {
        const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
        const targetId = typeof link.target === 'string' ? link.target : link.target.id;
        return sourceId === selectedNode.id || targetId === selectedNode.id;
      })
      .sort((a, b) => b.totalAmount - a.totalAmount)
      .slice(0, 40);
  }, [graphData.links, selectedNode]);

  const sortedNodes = useMemo(() => {
    return [...graphData.nodes].sort((a, b) => {
      if (a.isRoot) return -1;
      if (b.isRoot) return 1;
      return b.balance - a.balance;
    });
  }, [graphData.nodes]);

  // Measure container so ForceGraph2D knows its exact dimensions
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setGraphSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!graphData.nodes.length) return;
    const timeout = window.setTimeout(() => {
      graphRef.current?.zoomToFit?.(900, 60);
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [graphData.nodes.length, graphData.links.length]);

  useEffect(() => {
    if (!selectedNodeId) {
      if (rootNode) setSelectedNodeId(rootNode.id);
      return;
    }
    if (!nodeMap.has(selectedNodeId)) {
      setSelectedNodeId(rootNode?.id || null);
    }
  }, [nodeMap, rootNode, selectedNodeId]);

  const submitSearch = () => {
    const normalized = addressInput.trim();
    if (!looksLikeAddress(normalized)) return;
    setQueryAddress(normalized);
    setQueryDepth(depthInput);
    setQueryMaxNodes(maxNodesInput);
    setSelectedNodeId(normalized);
    setSearchParams({
      address: normalized,
      depth: String(depthInput),
      maxNodes: String(maxNodesInput),
    });
  };

  const focusNode = (node: GraphNode | null) => {
    if (!node) return;
    setSelectedNodeId(node.id);
    if (typeof node.x === 'number' && typeof node.y === 'number') {
      graphRef.current?.centerAt?.(node.x, node.y, 600);
      graphRef.current?.zoom?.(1.8, 600);
    }
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title"><HiOutlineShare /> Bubblemaps</h1>
        <p className="page-subtitle">
          Wallet relationship graph around a DFCN address with balance-sized nodes and transfer-weighted links.
        </p>
      </div>

      <div className="bubblemaps-toolbar card">
        <div className="bubblemaps-input-wrap">
          <HiOutlineMagnifyingGlass />
          <input
            value={addressInput}
            onChange={(event) => setAddressInput(event.target.value)}
            placeholder="Enter DFCN address to map relationships"
            className="bubblemaps-input"
          />
        </div>
        <div className="bubblemaps-controls">
          <label className="bubblemaps-select-label">
            Depth
            <select
              value={depthInput}
              onChange={(event) => setDepthInput(Number(event.target.value))}
              className="bubblemaps-select"
            >
              <option value={1}>1 hop</option>
              <option value={2}>2 hops</option>
              <option value={3}>3 hops</option>
            </select>
          </label>
          <label className="bubblemaps-select-label">
            Nodes
            <select
              value={maxNodesInput}
              onChange={(event) => setMaxNodesInput(Number(event.target.value))}
              className="bubblemaps-select"
            >
              {NODE_LIMIT_OPTIONS.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!looksLikeAddress(addressInput.trim())}
            onClick={submitSearch}
          >
            Analyze
          </button>
        </div>
      </div>

      {!queryEnabled && (
        <div className="card bubblemaps-empty">
          <p className="text-muted">Enter a valid DFCN address and click Analyze to build the map.</p>
        </div>
      )}

      {queryEnabled && (
        <div className="bubblemaps-grid">
          <div className="card bubblemaps-graph-card">
            <div className="card-header bubblemaps-card-header">
              <h2 className="card-title">
                <HiOutlineArrowsPointingOut /> Relationship Graph
              </h2>
              <div className="bubblemaps-meta">
                <span>{formatNumber(graphQuery.data?.nodeCount || 0)} nodes</span>
                <span>{formatNumber(graphQuery.data?.edgeCount || 0)} links</span>
              </div>
            </div>

            {graphQuery.isLoading ? (
              <div className="bubblemaps-empty">
                <p className="text-muted">Building graph...</p>
              </div>
            ) : graphQuery.error ? (
              <div className="bubblemaps-empty">
                <p className="text-muted">
                  {((graphQuery.error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ||
                    (graphQuery.error as Error)?.message ||
                    'Failed to build graph')}
                </p>
              </div>
            ) : graphData.nodes.length === 0 ? (
              <div className="bubblemaps-empty">
                <p className="text-muted">No relationship data found for this address.</p>
              </div>
            ) : (
              <div className="bubblemaps-graph-wrap" ref={wrapRef}>
                <ForceGraph2D
                  ref={graphRef}
                  width={graphSize.width}
                  height={graphSize.height}
                  graphData={graphData}
                  backgroundColor="transparent"
                  cooldownTicks={130}
                  nodeRelSize={4}
                  linkWidth={(link: GraphLink) => Math.max(0.4, Math.log10((link.totalAmount || 0) + 1))}
                  linkColor={(link: GraphLink) => {
                    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
                    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
                    const selected = selectedNodeId && (selectedNodeId === sourceId || selectedNodeId === targetId);
                    return selected ? 'rgba(122, 185, 255, 0.9)' : 'rgba(114, 146, 188, 0.28)';
                  }}
                  linkDirectionalArrowLength={2.6}
                  linkDirectionalArrowRelPos={0.95}
                  linkDirectionalArrowColor={() => 'rgba(149, 176, 214, 0.62)'}
                  onNodeClick={(node) => focusNode(node as GraphNode)}
                  nodeCanvasObject={(nodeObject, ctx, globalScale) => {
                    const node = nodeObject as GraphNode;
                    const label = node.isRoot ? `${truncateHash(node.address, 10)} (root)` : truncateHash(node.address, 9);
                    const fontSize = Math.max(9, 11 / globalScale);
                    const radius = resolveNodeSize(node);
                    const color = resolveNodeColor(node);

                    ctx.beginPath();
                    ctx.arc(node.x || 0, node.y || 0, radius + 2.2, 0, 2 * Math.PI, false);
                    ctx.fillStyle = 'rgba(18, 33, 54, 0.72)';
                    ctx.fill();

                    ctx.beginPath();
                    ctx.arc(node.x || 0, node.y || 0, radius, 0, 2 * Math.PI, false);
                    ctx.fillStyle = color;
                    ctx.fill();

                    if (node.id === selectedNodeId) {
                      ctx.beginPath();
                      ctx.arc(node.x || 0, node.y || 0, radius + 3.8, 0, 2 * Math.PI, false);
                      ctx.strokeStyle = 'rgba(122, 185, 255, 0.95)';
                      ctx.lineWidth = 1.6;
                      ctx.stroke();
                    }

                    ctx.font = `${fontSize}px 'IBM Plex Mono'`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillStyle = 'rgba(210, 226, 248, 0.94)';
                    ctx.fillText(label, node.x || 0, (node.y || 0) + radius + 4.5);
                  }}
                />
              </div>
            )}
          </div>

          <aside className="card bubblemaps-sidebar">
            <div className="card-header bubblemaps-card-header">
              <h2 className="card-title">Address List</h2>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  if (rootNode) focusNode(rootNode);
                }}
                disabled={!rootNode}
              >
                <HiOutlineArrowPath /> Root
              </button>
            </div>

            <div className="bubblemaps-list">
              {sortedNodes.map((node) => (
                <button
                  type="button"
                  key={node.id}
                  className={`bubblemaps-list-item ${selectedNodeId === node.id ? 'active' : ''}`}
                  onClick={() => focusNode(node)}
                >
                  <span className="bubblemaps-dot" style={{ background: resolveNodeColor(node) }} />
                  <span className="bubblemaps-list-main">
                    <span className="bubblemaps-list-address">{truncateHash(node.address, 11)}</span>
                    <span className="bubblemaps-list-meta">
                      Depth {node.depth} - {formatCoin(node.balance)} DFCN
                    </span>
                  </span>
                </button>
              ))}
            </div>

            {selectedNode && (
              <div className="bubblemaps-selected">
                <h3>Selected Address</h3>
                <p className="mono bubblemaps-selected-address">{selectedNode.address}</p>
                <div className="bubblemaps-selected-stats">
                  <div>
                    <span>Balance</span>
                    <strong>{formatCoin(selectedNode.balance)} DFCN</strong>
                  </div>
                  <div>
                    <span>Tx Count</span>
                    <strong>{formatNumber(selectedNode.txCount)}</strong>
                  </div>
                  <div>
                    <span>Depth</span>
                    <strong>{selectedNode.depth}</strong>
                  </div>
                </div>
                <div className="bubblemaps-selected-links">
                  <Link to={`/address/${encodeURIComponent(selectedNode.address)}`}>Address Page</Link>
                </div>
              </div>
            )}

            {selectedNode && (
              <div className="bubblemaps-transfers">
                <h3>Connected Transfers</h3>
                {connectedLinks.length === 0 ? (
                  <p className="text-muted">No edge data for selected node.</p>
                ) : (
                  <div className="bubblemaps-transfer-list">
                    {connectedLinks.map((link, index) => {
                      const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
                      const targetId = typeof link.target === 'string' ? link.target : link.target.id;
                      const direction = sourceId === selectedNode.id ? 'OUT' : 'IN';
                      const peer = sourceId === selectedNode.id ? targetId : sourceId;
                      return (
                        <div key={`${sourceId}-${targetId}-${index}`} className="bubblemaps-transfer-item">
                          <div className="bubblemaps-transfer-head">
                            <span className={`badge ${direction === 'IN' ? 'success' : 'warning'}`}>{direction}</span>
                            <span className="mono">{truncateHash(peer, 10)}</span>
                          </div>
                          <div className="bubblemaps-transfer-meta">
                            <span>{formatCoin(link.totalAmount)} DFCN</span>
                            <span>{formatNumber(link.txCount)} tx</span>
                            <span>{link.lastBlocktime ? formatAge(link.lastBlocktime) : 'unknown time'}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
