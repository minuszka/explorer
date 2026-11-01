import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import masternodeV1Routes from './masternodes.v1.routes';
import networkV1Routes from './network.v1.routes';
import rewardsV1Routes from './rewards.v1.routes';
import blocksV1Routes from './blocks.v1.routes';
import txsV1Routes from './txs.v1.routes';
import addressV1Routes from './address.v1.routes';
import metaV1Routes from './meta.v1.routes';
import providerTagsV1Routes from './providerTags.v1.routes';
import nodeInventoryV1Routes from './nodeInventory.v1.routes';
import networkNoiseV1Routes from './networkNoise.v1.routes';
import migrationRoutes from '../migration.routes';
import { config } from '../../config';
import poseChainRoutes from './poseChain.v1.routes';
import operatorDiagnosisRoutes from './operatorDiagnosis.v1.routes';
import banAttributionRoutes from './banAttribution.v1.routes';
import { resolveRequestIp } from '../../utils/requestIp';

const router = Router();

// Stricter per-IP limiter for compute-heavy endpoints (graph traversal,
// reward aggregation, masternode health snapshot, ban-wave clustering).
// The global apiLimiter (1200/min default) is too loose for these paths
// because each call can fan out to dozens of Mongo aggregations.
const heavyEndpointLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => resolveRequestIp(req, config.rateLimit.ipHeaders),
});

router.use('/masternodes/health', heavyEndpointLimiter);
router.use('/masternodes/ban-waves', heavyEndpointLimiter);
router.use('/masternodes/pose-chain', heavyEndpointLimiter);
router.use('/masternodes/operator-diagnosis', heavyEndpointLimiter);
router.use('/masternodes/ban-attribution', heavyEndpointLimiter);
router.use('/address/:address/graph', heavyEndpointLimiter);
router.use('/address/:address/rewards', heavyEndpointLimiter);

// Keep these ahead of masternodeV1Routes: its /:id route matches any single path segment.
router.use('/masternodes', operatorDiagnosisRoutes);
router.use('/masternodes', banAttributionRoutes);
router.use('/masternodes', poseChainRoutes);
router.use('/masternodes', masternodeV1Routes);
router.use('/network', networkV1Routes);
router.use('/rewards', rewardsV1Routes);
router.use('/blocks', blocksV1Routes);
router.use('/txs', txsV1Routes);
router.use('/address', addressV1Routes);
router.use('/meta', metaV1Routes);
router.use('/provider-tags', providerTagsV1Routes);
router.use('/node-inventory', nodeInventoryV1Routes);
router.use('/network-noise', networkNoiseV1Routes);
router.use('/migration', migrationRoutes);

export default router;
