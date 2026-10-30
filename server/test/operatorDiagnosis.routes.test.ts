import express from 'express';
import request from 'supertest';
import routes from '../src/routes/v1/operatorDiagnosis.v1.routes';
import { getOperatorDiagnosis } from '../src/services/operatorDiagnosis.service';
import { operatorDiagnosisApiResponseSchema } from '@defcon/shared/dist/contracts';
vi.mock('../src/services/operatorDiagnosis.service', () => ({ getOperatorDiagnosis: vi.fn() }));
const app = express(); app.use('/api/v1/masternodes', routes);
describe('operator diagnosis route', () => {
  it('returns the shared contract with no-store', async () => {
    const now = new Date().toISOString();
    vi.mocked(getOperatorDiagnosis).mockResolvedValue({ generatedAt: now, registeredCount: 220, maxPenalty: 220,
      historySince: now, historyLimited: true, nodes: [], dsl: { status: 'unknown', reason: 'Core version unavailable',
      coreVersion: null, activationHeight: null, enforcementHeight: null, currentEpoch: null, latestCommittedEpoch: null,
      rule: null, simulation: null } });
    const res = await request(app).get('/api/v1/masternodes/operator-diagnosis');
    expect(res.status).toBe(200); expect(res.headers['cache-control']).toContain('no-store');
    expect(operatorDiagnosisApiResponseSchema.safeParse(res.body).success).toBe(true);
  });
  it('returns unavailable rather than a stale action list on a source failure', async () => {
    vi.mocked(getOperatorDiagnosis).mockRejectedValue(new Error('private RPC credentials must not be returned'));
    const res = await request(app).get('/api/v1/masternodes/operator-diagnosis');
    expect(res.status).toBe(503); expect(JSON.stringify(res.body)).not.toContain('private RPC');
  });
});
