import { Router, Request, Response } from 'express';
import { Address } from '../models/Address';
import { Transaction } from '../models/Transaction';
import { getChainTip } from '../services/chainTip.service';
import { withCachePolicy } from '../middleware/cachePolicy';
import { normalizeAddressAmounts, normalizeTransactionAmounts, satToCoin, satToString, type SatLike } from '../utils/amounts';
import {
  addressParamSchema,
  firstValidationIssueMessage,
  parsePaginationQuery,
  sendInternalError,
  sendValidationError,
} from '../utils/validation';

const router = Router();

// The address page shows each transaction's input total, fee and reward label from this list,
// so the projection must keep the same stored totals that /api/tx/:txid returns.
const ADDRESS_TX_LIST_PROJECTION = {
  txid: 1,
  blockheight: 1,
  blocktime: 1,
  isCoinbase: 1,
  totalValueInSat: 1,
  totalValueOutSat: 1,
  feeSat: 1,
  'vin.address': 1,
  'vin.valueSat': 1,
  'vout.valueSat': 1,
  'vout.scriptPubKey.addresses': { $slice: 1 },
};
let involvedAddressFieldDetected: boolean | null = null;
let involvedAddressFieldCheckedAt = 0;
const INVOLVED_FIELD_RECHECK_MS = 30 * 60_000;

function buildLegacyAddressTxQuery(address: string) {
  return {
    $or: [
      { 'vin.address': address },
      { 'vout.scriptPubKey.addresses': address },
    ],
  };
}

async function hasInvolvedAddressField(): Promise<boolean> {
  if (involvedAddressFieldDetected === true) return true;
  const now = Date.now();
  if (involvedAddressFieldDetected === false && now - involvedAddressFieldCheckedAt < INVOLVED_FIELD_RECHECK_MS) {
    return false;
  }
  const sample = await Transaction.findOne({ involvedAddresses: { $exists: true, $ne: [] } })
    .select({ _id: 1 })
    .lean();
  involvedAddressFieldDetected = !!sample;
  involvedAddressFieldCheckedAt = now;
  return involvedAddressFieldDetected;
}

void hasInvolvedAddressField().catch(() => {
  // Lazy warm-up only. Route handler does runtime fallback if detection fails.
});

function withTxConfirmations<T extends { blockheight: number; confirmations?: number }>(
  tx: T,
  bestHeight: number
): T {
  (tx as Record<string, unknown>).confirmations = Math.max(0, bestHeight - tx.blockheight + 1);
  return tx;
}

router.get('/:address', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const paramParsed = addressParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paramParsed.error));
    }

    const { address } = paramParsed.data;
    const addr = await Address.findOne({ address }).lean<Record<string, unknown>>();
    if (!addr) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Address not found' } });
    }
    res.json({ success: true, data: normalizeAddressAmounts(addr) });
  } catch (error) {
    sendInternalError(res, 'Failed to fetch address', error);
  }
});

router.get('/:address/balance', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const paramParsed = addressParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paramParsed.error));
    }
    const { address } = paramParsed.data;
    const addr = await Address.findOne({ address })
      .select({ balanceSat: 1, totalReceivedSat: 1, totalSentSat: 1, txCount: 1 })
      .lean<{ balanceSat: SatLike; totalReceivedSat: SatLike; totalSentSat: SatLike; txCount: number }>();
    if (!addr) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Address not found' } });
    }
    res.json({
      success: true,
      data: {
        address,
        balanceSat: satToString(addr.balanceSat),
        balance: satToCoin(addr.balanceSat),
        totalReceivedSat: satToString(addr.totalReceivedSat),
        totalReceived: satToCoin(addr.totalReceivedSat),
        totalSentSat: satToString(addr.totalSentSat),
        totalSent: satToCoin(addr.totalSentSat),
        txCount: addr.txCount,
      },
    });
  } catch (error) {
    sendInternalError(res, 'Failed to fetch balance', error);
  }
});

router.get('/:address/txs', withCachePolicy('short'), async (req: Request, res: Response) => {
  try {
    const paramParsed = addressParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paramParsed.error));
    }
    const { address } = paramParsed.data;

    const paginationParsed = parsePaginationQuery(req.query as Record<string, unknown>, {
      page: 1,
      limit: 20,
    });
    if (!paginationParsed.success) {
      return sendValidationError(res, firstValidationIssueMessage(paginationParsed.error));
    }
    const { page, limit } = paginationParsed.data;
    const skip = (page - 1) * limit;

    const legacyQuery = buildLegacyAddressTxQuery(address);
    const indexedQuery = { involvedAddresses: address };
    const canUseIndexedQuery = await hasInvolvedAddressField();
    const primaryQuery = canUseIndexedQuery ? indexedQuery : legacyQuery;
    const addressMetaPromise = canUseIndexedQuery
      ? Address.findOne({ address }).select({ txCount: 1 }).lean<{ txCount?: number }>()
      : Promise.resolve(null);

    let [txs, total, tip, addressMeta] = await Promise.all([
      Transaction.find(primaryQuery)
        .sort({ blockheight: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .select(ADDRESS_TX_LIST_PROJECTION)
        .lean(),
      Transaction.countDocuments(primaryQuery),
      getChainTip(),
      addressMetaPromise,
    ]);

    const addressTxCount = Math.max(0, Number(addressMeta?.txCount ?? 0));
    if (canUseIndexedQuery && total === 0 && addressTxCount > 0) {
      [txs, total] = await Promise.all([
        Transaction.find(legacyQuery)
          .sort({ blockheight: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .select(ADDRESS_TX_LIST_PROJECTION)
          .lean(),
        Transaction.countDocuments(legacyQuery),
      ]);
    }

    const bestHeight = tip.height;
    const data = txs.map((tx) =>
      withTxConfirmations(normalizeTransactionAmounts(tx, { maxVoutAddresses: 1 }), bestHeight)
    );

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    sendInternalError(res, 'Failed to fetch transactions', error);
  }
});

export default router;
