import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkNoiseNodeState } from '../src/models/NetworkNoiseNodeState';
import { NetworkNoiseObservation } from '../src/models/NetworkNoiseObservation';
import { PoseObservation } from '../src/models/PoseObservation';
import { networkNoiseService } from '../src/services/networkNoise.service';
import { networkNoiseBatchService } from '../src/services/networkNoiseBatch.service';
import { poseTelemetryService } from '../src/services/poseTelemetry.service';
import { posePayload } from './fixtures/poseTelemetry';

describe('structured telemetry persistence and retry boundaries', () => {
  beforeEach(() => {
    vi.spyOn(networkNoiseBatchService, 'claim').mockResolvedValue('process');
    vi.spyOn(networkNoiseBatchService, 'complete').mockResolvedValue();
    vi.spyOn(PoseObservation, 'init').mockResolvedValue(PoseObservation);
    vi.spyOn(NetworkNoiseNodeState, 'init').mockResolvedValue(NetworkNoiseNodeState);
    vi.spyOn(NetworkNoiseNodeState, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => null }),
    } as never);
    vi.spyOn(NetworkNoiseNodeState, 'updateOne').mockResolvedValue({} as never);
    vi.spyOn(NetworkNoiseObservation, 'bulkWrite').mockResolvedValue({ upsertedCount: 1 } as never);
    vi.spyOn(PoseObservation, 'bulkWrite').mockResolvedValue({ upsertedCount: 1 } as never);
  });

  it('keeps event time, report time, server receipt and snapshot anchors separate', async () => {
    const result = await networkNoiseService.ingest(posePayload());
    expect(result.acceptedPoseObservations).toBe(1);
    const operation = vi.mocked(PoseObservation.bulkWrite).mock.calls[0][0][0] as any;
    const record = operation.updateOne.update.$setOnInsert;
    expect(record.eventBlockHeight).toBe(147909);
    expect(record.snapshotBlockHeight).toBe(147912);
    expect(record.eventBlockHash).toBe('a'.repeat(64));
    expect(record.snapshotBlockHash).toBe('d'.repeat(64));
    expect(record.eventAt.toISOString()).toBe('2026-10-06T12:01:00.000Z');
    expect(record.observedAt.toISOString()).toBe('2026-10-06T12:03:00.000Z');
    expect(record.expiresAt.getTime() - record.receivedAt.getTime()).toBe(365 * 86400000);
    expect(record).not.toHaveProperty('ip');
    const update = vi.mocked(NetworkNoiseNodeState.updateOne).mock.calls[0][1] as any;
    expect(update.$set).not.toHaveProperty('lastCleanAt');
  });

  it('leaves the sequence retryable when structured persistence fails', async () => {
    const error = new Error('storage failure');
    vi.mocked(PoseObservation.bulkWrite).mockRejectedValue(error);
    await expect(networkNoiseService.ingest(posePayload())).rejects.toBe(error);
    expect(NetworkNoiseNodeState.updateOne).not.toHaveBeenCalled();
  });

  it('does not discard mixed failures when the bulk error begins with a duplicate key', async () => {
    const error = { code: 11000, writeErrors: [{ code: 11000 }, { code: 121 }] };
    vi.mocked(PoseObservation.bulkWrite).mockRejectedValue(error);
    await expect(networkNoiseService.ingest(posePayload())).rejects.toBe(error);
    expect(NetworkNoiseNodeState.updateOne).not.toHaveBeenCalled();
  });

  it('accepts only duplicate-key races and reports actual partial inserts', async () => {
    vi.mocked(PoseObservation.bulkWrite).mockRejectedValue({
      code: 11000, writeErrors: [{ code: 11000 }], result: { upsertedCount: 1 },
    });
    const result = await networkNoiseService.ingest(posePayload());
    expect(result.acceptedPoseObservations).toBe(1);
    expect(NetworkNoiseNodeState.updateOne).toHaveBeenCalledOnce();
  });

  it('propagates a non-duplicate state-write failure so the batch can retry', async () => {
    const error = new Error('node state write failed');
    vi.mocked(NetworkNoiseNodeState.updateOne).mockRejectedValue(error);
    await expect(networkNoiseService.ingest(posePayload())).rejects.toBe(error);
    expect(NetworkNoiseNodeState.updateOne).toHaveBeenCalledOnce();
  });

  it('propagates a failed conditional retry after a node-key race', async () => {
    const error = new Error('conditional retry failed');
    vi.mocked(NetworkNoiseNodeState.updateOne).mockRejectedValueOnce({ code: 11000 }).mockRejectedValueOnce(error);
    await expect(networkNoiseService.ingest(posePayload())).rejects.toBe(error);
    expect(NetworkNoiseNodeState.updateOne).toHaveBeenCalledTimes(2);
  });

  it('does not write structured events for a duplicate sequence', async () => {
    vi.mocked(networkNoiseBatchService.claim).mockResolvedValue('duplicate');
    const result = await networkNoiseService.ingest(posePayload());
    expect(result).toEqual({ duplicate: true, acceptedSignals: 0, noiseScore: 0, acceptedPoseObservations: 0 });
    expect(PoseObservation.bulkWrite).not.toHaveBeenCalled();
  });

  it('preserves the v1 response and clean cycle without writing PoSe observations', async () => {
    const { poseEvents: _removed, ...payload } = posePayload();
    const result = await networkNoiseService.ingest({ ...payload, schemaVersion: 1 });
    expect(result).toEqual({ duplicate: false, acceptedSignals: 0, noiseScore: 0 });
    expect(PoseObservation.bulkWrite).not.toHaveBeenCalled();
    const update = vi.mocked(NetworkNoiseNodeState.updateOne).mock.calls[0][1] as any;
    expect(update.$set.lastCleanAt).toEqual(new Date(payload.observedAt));
  });

  it('reports zero accepted observations on a clean v2 cycle', async () => {
    expect(await poseTelemetryService.ingest(posePayload({ poseEvents: [] }))).toBe(0);
    expect(PoseObservation.bulkWrite).not.toHaveBeenCalled();
  });
});
