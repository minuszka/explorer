import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  networkNoiseSummaryApiResponseSchema,
  networkNoiseIngestSchema,
  poseEventsQuerySchema,
  poseObservedEventsApiResponseSchema,
} from '@defcon/shared/dist/contracts';
import { config } from '../../config';
import { withCachePolicy } from '../../middleware/cachePolicy';
import { networkNoiseService } from '../../services/networkNoise.service';
import { poseTelemetryService } from '../../services/poseTelemetry.service';
import { NetworkNoiseSequenceConflict } from '../../services/networkNoiseBatch.service';
import { resolveRequestIp } from '../../utils/requestIp';
import {
  firstValidationIssueMessage,
  sendInternalError,
  sendValidationError,
} from '../../utils/validation';

const router = Router();

const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => resolveRequestIp(req, config.rateLimit.ipHeaders),
});

function bearerToken(req: Request): string {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function safeTokenEquals(actual: string, expected: string): boolean {
  // Hash both sides to fixed-length digests first, so the comparison takes the
  // same time whatever the token lengths are and does not leak the length.
  const actualHash = crypto.createHash('sha256').update(actual, 'utf8').digest();
  const expectedHash = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

router.post('/ingest', ingestLimiter, async (req: Request, res: Response) => {
  if (!config.networkNoise.enabled) {
    return res.status(503).json({
      success: false,
      error: { code: 'DISABLED', message: 'Network noise ingest is disabled' },
    });
  }

  const parsed = networkNoiseIngestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendValidationError(res, firstValidationIssueMessage(parsed.error));
  }

  const expectedToken = config.networkNoise.ingestTokens[parsed.data.nodeId];
  const token = bearerToken(req);
  if (!expectedToken || !token || !safeTokenEquals(token, expectedToken)) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid node ingest credentials' },
    });
  }

  try {
    const result = await networkNoiseService.ingest(parsed.data);
    return res.status(result.duplicate ? 200 : 202).json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error instanceof NetworkNoiseSequenceConflict) {
      return res.status(409).json({ success: false, error: { code: 'SEQUENCE_CONFLICT', message: error.message } });
    }
    return sendInternalError(res, 'Failed to ingest network noise telemetry', error);
  }
});

router.get('/pose-events', withCachePolicy('no-store'), async (req: Request, res: Response) => {
  const parsed = poseEventsQuerySchema.safeParse(req.query);
  if (!parsed.success) return sendValidationError(res, firstValidationIssueMessage(parsed.error));
  try {
    const data = await poseTelemetryService.getEvents(parsed.data);
    return res.json(poseObservedEventsApiResponseSchema.parse({ success: true, data }));
  } catch (error) {
    return sendInternalError(res, 'Failed to load PoSe observations', error);
  }
});

router.get('/summary', withCachePolicy('no-store'), async (req: Request, res: Response) => {
  const parsedHours = Number.parseInt(String(req.query.hours ?? '24'), 10);
  const hours = Math.min(Math.max(Number.isFinite(parsedHours) ? parsedHours : 24, 1), 720);

  try {
    const data = await networkNoiseService.getSummary(hours);
    return res.json(networkNoiseSummaryApiResponseSchema.parse({ success: true, data }));
  } catch (error) {
    return sendInternalError(res, 'Failed to load network noise summary', error);
  }
});

export default router;
