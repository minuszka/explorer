import { Router, type Request, type Response } from 'express';
import { Address } from '../models/Address';
import { Transaction } from '../models/Transaction';
import { Block } from '../models/Block';
import { MasternodeEvent } from '../models/MasternodeEvent';
import { getChainTip } from '../services/chainTip.service';
import { getEnrichedPayload } from '../services/masternode.service';
import { config } from '../config';
import { withCachePolicy } from '../middleware/cachePolicy';
import { satToString, type SatLike } from '../utils/amounts';
import { sendInternalError } from '../utils/validation';

const router = Router();

// Public, read-only, rate-limited API meant for AI agents/bots. Always allow
// cross-origin reads here, independent of the CORS_ORIGINS allowlist used by
// the rest of the API.
router.use((req: Request, res: Response, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ── helpers ──────────────────────────────────────────────────────────────────

function sat(v: SatLike): string {
  return satToString(v);
}

function unixToIso(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString();
}

// DeFCoN address: starts with D, 26–34 base58 chars
function isAddress(q: string): boolean {
  return /^D[1-9A-HJ-NP-Za-km-z]{25,33}$/.test(q);
}

// 64-char hex = tx hash OR block hash
function isHex64(q: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(q);
}

// positive integer = block height
function isBlockHeight(q: string): boolean {
  return /^\d{1,7}$/.test(q) && Number(q) >= 0;
}

// ── GET /api/ai/lookup?q= ────────────────────────────────────────────────────

router.get('/lookup', withCachePolicy('short'), async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    return res.status(400).json({
      success: false,
      hint: 'Provide ?q= with a DeFCoN address, tx hash, block hash, or block height.',
      examples: [
        '/api/ai/lookup?q=D9uqHkeoqWDQ6CZS7BekgdVozuJ33yYFby',
        '/api/ai/lookup?q=a9d2e303f79dad1fb8da2cc500f3d03370687fe9985bb3d9c2b9a2b95da34ac6',
        '/api/ai/lookup?q=80759',
      ],
    });
  }

  try {
    // ── Address ──────────────────────────────────────────────────────────────
    if (isAddress(q)) {
      const addr = await Address.findOne({ address: q })
        .select({ address: 1, balanceSat: 1, totalReceivedSat: 1, totalSentSat: 1, txCount: 1, firstSeen: 1, lastSeen: 1 })
        .lean<Record<string, unknown>>();

      if (!addr) {
        return res.status(404).json({ success: false, type: 'address', query: q, error: 'Address not found. It may have zero balance and no transactions.' });
      }

      return res.json({
        success: true,
        type: 'address',
        data: {
          address: q,
          balance: sat(addr.balanceSat as SatLike),
          totalReceived: sat(addr.totalReceivedSat as SatLike),
          totalSent: sat(addr.totalSentSat as SatLike),
          txCount: addr.txCount,
          firstSeen: unixToIso(addr.firstSeen as number),
          lastSeen: unixToIso(addr.lastSeen as number),
          explorerUrl: `${config.publicSiteUrl}/address/${q}`,
        },
      });
    }

    // ── Block height ─────────────────────────────────────────────────────────
    if (isBlockHeight(q)) {
      const height = Number(q);
      const block = await Block.findOne({ height })
        .select({ hash: 1, height: 1, time: 1, nTx: 1, rewardSat: 1, totalValueOutSat: 1, size: 1, difficulty: 1, minedBy: 1 })
        .lean<Record<string, unknown>>();

      if (!block) {
        return res.status(404).json({ success: false, type: 'block', query: q, error: `Block #${height} not found.` });
      }

      return res.json({
        success: true,
        type: 'block',
        data: {
          height: block.height,
          hash: block.hash,
          time: unixToIso(block.time as number),
          txCount: block.nTx,
          reward: sat(block.rewardSat as SatLike),
          totalOut: sat(block.totalValueOutSat as SatLike),
          sizeBytes: block.size,
          difficulty: block.difficulty,
          minedBy: block.minedBy ?? null,
          explorerUrl: `${config.publicSiteUrl}/block/${height}`,
        },
      });
    }

    // ── 64-char hex: try tx first, then block hash ────────────────────────────
    if (isHex64(q)) {
      // Hashes are stored in lower case; one typed in capitals is the same hash.
      const hash = q.toLowerCase();
      const [tx, block] = await Promise.all([
        Transaction.findOne({ txid: hash })
          .select({ txid: 1, blockhash: 1, blockheight: 1, blocktime: 1, totalValueInSat: 1, totalValueOutSat: 1, feeSat: 1, isCoinbase: 1, vin: 1, vout: 1 })
          .lean<Record<string, unknown>>(),
        Block.findOne({ hash })
          .select({ hash: 1, height: 1, time: 1, nTx: 1, rewardSat: 1, size: 1 })
          .lean<Record<string, unknown>>(),
      ]);

      if (tx) {
        const tip = await getChainTip();
        const confirmations = tip ? Math.max(0, tip.height - (tx.blockheight as number) + 1) : null;

        const vinAddresses = (tx.vin as Array<Record<string, unknown>>)
          .map((v) => v.address as string)
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 5);

        const voutAddresses = (tx.vout as Array<Record<string, unknown>>)
          .flatMap((v) => ((v.scriptPubKey as Record<string, unknown>)?.addresses as string[]) ?? [])
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 5);

        return res.json({
          success: true,
          type: 'transaction',
          data: {
            txid: tx.txid,
            blockHeight: tx.blockheight,
            blockHash: tx.blockhash,
            time: unixToIso(tx.blocktime as number),
            confirmations,
            totalIn: sat(tx.totalValueInSat as SatLike),
            totalOut: sat(tx.totalValueOutSat as SatLike),
            fee: sat(tx.feeSat as SatLike),
            isCoinbase: tx.isCoinbase,
            fromAddresses: vinAddresses,
            toAddresses: voutAddresses,
            explorerUrl: `${config.publicSiteUrl}/tx/${tx.txid as string}`,
          },
        });
      }

      if (block) {
        return res.json({
          success: true,
          type: 'block',
          data: {
            height: block.height,
            hash: block.hash,
            time: unixToIso(block.time as number),
            txCount: block.nTx,
            reward: sat(block.rewardSat as SatLike),
            sizeBytes: block.size,
            explorerUrl: `${config.publicSiteUrl}/block/${block.height as number}`,
          },
        });
      }

      return res.status(404).json({ success: false, type: 'unknown', query: q, error: 'No transaction or block found with this hash.' });
    }

    return res.status(400).json({
      success: false,
      error: 'Unrecognized query format. Provide a DeFCoN address (starts with D), a 64-character hex hash, or a block height number.',
    });
  } catch (err) {
    return sendInternalError(res, 'AI endpoint failed', err);
  }
});

// ── GET /api/ai/network ───────────────────────────────────────────────────────

router.get('/network', withCachePolicy('short'), async (_req: Request, res: Response) => {
  try {
    const [tip, payload] = await Promise.all([
      getChainTip(),
      getEnrichedPayload(),
    ]);

    const nodes = payload.nodes;
    const enabled = nodes.filter((n) => n.status === 'ENABLED' || n.status === 'POSE_PENALTY').length;
    const banned  = nodes.filter((n) => String(n.status).includes('BAN')).length;
    const penalty = nodes.filter((n) => n.status === 'POSE_PENALTY').length;

    return res.json({
      success: true,
      type: 'network',
      data: {
        blockHeight: tip?.height ?? null,
        blockHash:   tip?.hash  ?? null,
        masternodes: {
          total:      payload.total,
          enabled,
          posePenalty: penalty,
          poseBanned:  banned,
        },
        explorerUrl: config.publicSiteUrl,
        hint: 'Use /api/ai/lookup?q=<address|txid|blockhash|blockheight> for specific lookups.',
      },
    });
  } catch (err) {
    return sendInternalError(res, 'AI endpoint failed', err);
  }
});

// ── GET /api/ai/masternode?q=<ip:port|proTxHash> ─────────────────────────────

router.get('/masternode', withCachePolicy('short'), async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    return res.status(400).json({
      success: false,
      hint: 'Provide ?q= with an IP, an IP:port (e.g. 203.0.113.10:8192) or a proTxHash.',
    });
  }

  try {
    const payload = await getEnrichedPayload();
    const qLower = q.toLowerCase();

    const node = payload.nodes.find((n) =>
      n.service === q ||
      n.ip === q ||
      n.service === `${q}:8192` ||
      n.id?.toLowerCase() === qLower ||
      n.proTxHash?.toLowerCase() === qLower
    );

    if (!node) {
      return res.status(404).json({ success: false, type: 'masternode', query: q, error: 'Masternode not found.' });
    }

    // last PoSe events
    const recentEvents = await MasternodeEvent.find({ service: node.service })
      .sort({ detectedAt: -1 })
      .limit(5)
      .select({ currentStatus: 1, previousStatus: 1, detectedAt: 1, _id: 0 })
      .lean();

    return res.json({
      success: true,
      type: 'masternode',
      data: {
        service:         node.service,
        status:          node.status,
        posePenalty:     node.posePenalty,
        poseBanHeight:   node.poseBanHeight,
        provider:        node.provider ?? null,
        country:         node.countryName ?? null,
        countryCode:     node.countryCode ?? null,
        lastSeen:        node.lastSeen ? unixToIso(node.lastSeen) : null,
        recentEvents:    recentEvents.map((e) => ({
          from: e.previousStatus,
          to:   e.currentStatus,
          at:   e.detectedAt instanceof Date ? e.detectedAt.toISOString() : null,
        })),
        explorerUrl: `${config.publicSiteUrl}/masternodes`,
      },
    });
  } catch (err) {
    return sendInternalError(res, 'AI endpoint failed', err);
  }
});

export default router;
