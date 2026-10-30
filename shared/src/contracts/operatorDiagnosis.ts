import { z } from 'zod';
import { apiSuccessSchema } from './api';

export const operatorDiagnosisSchema = z.object({
  code: z.enum(['BAN_NEXT_DKG', 'REVIVE_LOOP', 'OLD_VERSION', 'WRONG_CHAIN', 'DSL_MISSED']),
  level: z.enum(['action', 'warn', 'info']),
  evidence: z.enum(['chain', 'pattern', 'probe']),
  message: z.string(), hint: z.string(), since: z.string().datetime({ offset: true }),
  source: z.string(), operatorAction: z.boolean(),
}).refine(d => !d.operatorAction || (d.level === 'action' && d.evidence === 'chain'),
  'Operator action highlighting requires chain evidence');
const count = z.number().int().nonnegative();
/** Sentinel (DSL) state as reported by the daemon. The rule exists only in shadow mode; the
 *  simulation additionally needs a current commitment and is bound to that commitment's epoch. */
export const operatorDslSchema = z.object({
  status: z.enum(['inactive', 'shadow', 'unknown']),
  reason: z.string().nullable(), coreVersion: z.string().nullable(),
  activationHeight: z.number().int().nullable(), enforcementHeight: z.number().int().nullable(),
  currentEpoch: count.nullable(), latestCommittedEpoch: count.nullable(),
  rule: z.object({ source: z.string(), epochBlocks: count, suspendEpochs: count, banEpochs: count,
    massOutagePct: count }).nullable(),
  simulation: z.object({ asOfEpoch: count, wouldSuspend: count, wouldBan: count, uncounted: count }).nullable(),
}).refine(d => (d.status === 'shadow') === (d.rule !== null), 'A rule exists exactly in shadow mode')
  .refine(d => d.simulation === null || (d.status === 'shadow' && d.simulation.asOfEpoch === d.latestCommittedEpoch),
    'A simulation needs shadow mode and belongs to the latest committed epoch')
  .refine(d => d.status !== 'shadow' || d.simulation !== null || d.reason !== null,
    'A shadow status without a simulation must say why');
export const operatorDiagnosisDataSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  registeredCount: z.number().int().nonnegative(),
  maxPenalty: z.number().int().positive(),
  historySince: z.string().datetime({ offset: true }), historyLimited: z.boolean(),
  dsl: operatorDslSchema,
  nodes: z.array(z.object({
    proTxHash: z.string().regex(/^[a-f0-9]{64}$/), service: z.string(),
    operatorDiagnosis: z.array(operatorDiagnosisSchema),
  })),
});
export const operatorDiagnosisApiResponseSchema = apiSuccessSchema(operatorDiagnosisDataSchema);
export type OperatorDiagnosis = z.infer<typeof operatorDiagnosisSchema>;
export type OperatorDsl = z.infer<typeof operatorDslSchema>;
export type OperatorDiagnosisData = z.infer<typeof operatorDiagnosisDataSchema>;
