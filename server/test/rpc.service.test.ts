import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';

const { postMock, createMock } = vi.hoisted(() => {
  const post = vi.fn();
  const create = vi.fn(() => ({ post }));
  return { postMock: post, createMock: create };
});

vi.mock('axios', () => ({
  __esModule: true,
  default: {
    create: createMock,
  },
}));

import axios from 'axios';
import { rpcService } from '../src/services/rpc.service';
import { logger } from '../src/utils/logger';

describe('rpc service', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    createMock.mockClear();
    postMock.mockReset();
  });

  it('creates axios client with normalized baseURL', async () => {
    const axiosCreate = (axios as unknown as { create: Mock }).create;
    expect(axiosCreate).toBe(createMock);
    createMock.mockClear();

    vi.resetModules();
    await import('../src/services/rpc.service');
    expect(createMock).toHaveBeenCalledTimes(1);

    const firstCallArg = createMock.mock.calls[0][0] as { baseURL?: string };
    expect(typeof firstCallArg.baseURL).toBe('string');
    expect(firstCallArg.baseURL?.endsWith('/')).toBe(true);
  });

  it('returns result for successful RPC call', async () => {
    postMock.mockResolvedValue({
      data: { result: 123, error: null },
    });

    await expect(rpcService.call<number>('getblockcount')).resolves.toBe(123);
    expect(postMock).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        method: 'getblockcount',
        params: [],
      })
    );
  });

  it('serves a cached parameterless answer unless a fresh one is requested', async () => {
    postMock.mockResolvedValueOnce({ data: { result: 'first', error: null } })
      .mockResolvedValueOnce({ data: { result: 'second', error: null } });
    await expect(rpcService.call('getmininginfo')).resolves.toBe('first');
    await expect(rpcService.call('getmininginfo')).resolves.toBe('first');
    await expect(rpcService.call('getmininginfo', [], { fresh: true })).resolves.toBe('second');
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('throws when daemon returns RPC error payload', async () => {
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger as never);
    postMock.mockResolvedValue({
      data: { error: { message: 'bad method' } },
    });

    await expect(rpcService.call('unknownmethod')).rejects.toThrow('RPC unknownmethod: bad method');
    expect(logSpy).toHaveBeenCalledWith('RPC unknownmethod: bad method');
  });

  it("throws when RPC response is missing 'result' field", async () => {
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger as never);
    postMock.mockResolvedValue({
      data: { ok: true },
    });

    await expect(rpcService.call('getinfo')).rejects.toThrow(
      "RPC getinfo: response missing 'result' field"
    );
    expect(logSpy).toHaveBeenCalledWith("RPC getinfo: response missing 'result' field");
  });

  it('sanitizes credentials in logged and thrown network errors', async () => {
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger as never);
    postMock.mockRejectedValue(new Error('dial failed http://rpcuser:rpcpass@127.0.0.1:9998'));

    await expect(rpcService.call('getblock')).rejects.toThrow(
      'RPC getblock: dial failed http://***:***@127.0.0.1:9998'
    );
    expect(logSpy).toHaveBeenCalledWith(
      'RPC getblock failed: dial failed http://***:***@127.0.0.1:9998'
    );
  });

  it('passes through already wrapped RPC errors', async () => {
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger as never);
    postMock.mockRejectedValue(new Error('RPC getnetworkinfo: already wrapped'));

    await expect(rpcService.call('getnetworkinfo')).rejects.toThrow(
      'RPC getnetworkinfo: already wrapped'
    );
    expect(logSpy).toHaveBeenCalledWith('RPC getnetworkinfo: already wrapped');
  });

  it('delegates wrapper methods to call with expected params', async () => {
    const callSpy = vi.spyOn(rpcService, 'call').mockResolvedValue(undefined as never);

    await rpcService.getBlockCount();
    await rpcService.getBlockHash(7);
    await rpcService.getBlock('hash');
    await rpcService.getRawTransaction('txid');
    await rpcService.getRawTransaction('txid', true, 'blockhash');
    await rpcService.getBlockchainInfo();
    await rpcService.getMiningInfo();
    await rpcService.getNetworkInfo();
    await rpcService.getPeerInfo();
    await rpcService.getRawMemPool();
    await rpcService.getMempoolInfo();
    await rpcService.getMempoolEntry('txid');
    await rpcService.getDifficulty();
    await rpcService.getNetworkHashPS();
    await rpcService.getTxOutSetInfo();

    expect(callSpy).toHaveBeenNthCalledWith(1, 'getblockcount');
    expect(callSpy).toHaveBeenNthCalledWith(2, 'getblockhash', [7]);
    expect(callSpy).toHaveBeenNthCalledWith(3, 'getblock', ['hash', 2]);
    expect(callSpy).toHaveBeenNthCalledWith(4, 'getrawtransaction', ['txid', true]);
    expect(callSpy).toHaveBeenNthCalledWith(5, 'getrawtransaction', ['txid', true, 'blockhash']);
    expect(callSpy).toHaveBeenNthCalledWith(6, 'getblockchaininfo');
    expect(callSpy).toHaveBeenNthCalledWith(7, 'getmininginfo');
    expect(callSpy).toHaveBeenNthCalledWith(8, 'getnetworkinfo');
    expect(callSpy).toHaveBeenNthCalledWith(9, 'getpeerinfo');
    expect(callSpy).toHaveBeenNthCalledWith(10, 'getrawmempool');
    expect(callSpy).toHaveBeenNthCalledWith(11, 'getmempoolinfo');
    expect(callSpy).toHaveBeenNthCalledWith(12, 'getmempoolentry', ['txid']);
    expect(callSpy).toHaveBeenNthCalledWith(13, 'getdifficulty');
    expect(callSpy).toHaveBeenNthCalledWith(14, 'getnetworkhashps', [120, -1]);
    expect(callSpy).toHaveBeenNthCalledWith(15, 'gettxoutsetinfo');
  });

  it('testConnection returns true on success and false on failure', async () => {
    const countSpy = vi.spyOn(rpcService, 'getBlockCount');

    countSpy.mockResolvedValueOnce(1);
    await expect(rpcService.testConnection()).resolves.toBe(true);

    countSpy.mockRejectedValueOnce(new Error('offline'));
    await expect(rpcService.testConnection()).resolves.toBe(false);
  });
});
