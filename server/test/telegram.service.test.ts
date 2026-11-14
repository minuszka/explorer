import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ bots: [] as Array<{ launch: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> }));

vi.mock('telegraf', () => ({
  Telegraf: class {
    launch = vi.fn(() => Promise.resolve());
    stop = vi.fn();
    command = vi.fn();
    action = vi.fn();
    use = vi.fn();
    constructor() {
      mocks.bots.push(this);
    }
  },
  Markup: { inlineKeyboard: vi.fn(), button: { callback: vi.fn() } },
}));

import { config } from '../src/config';
import { telegramService } from '../src/services/telegram.service';

describe('telegram service start', () => {
  const telegram = config.telegram as { botToken: string; adminId: number };
  const saved = { ...telegram };
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const listenersBefore = Object.fromEntries(signals.map((signal) => [signal, process.listeners(signal)]));

  afterEach(() => {
    telegramService.stop();
    Object.assign(telegram, saved);
    // Drop the shutdown handlers the service registered, so they do not outlive the test.
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!listenersBefore[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    mocks.bots.length = 0;
  });

  it('starts one bot, one stall check and one pair of shutdown handlers when started twice', () => {
    Object.assign(telegram, { botToken: 'test-token', adminId: 42 });
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const sigterm = process.listenerCount('SIGTERM');

    telegramService.start();
    telegramService.start();

    expect(mocks.bots).toHaveLength(1);
    expect(mocks.bots[0].launch).toHaveBeenCalledTimes(1);
    expect(intervals).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm + 1);
  });

  it('can start again after a stop', () => {
    Object.assign(telegram, { botToken: 'test-token', adminId: 42 });

    telegramService.start();
    telegramService.stop();
    telegramService.start();

    expect(mocks.bots).toHaveLength(2);
    expect(mocks.bots[0].stop).toHaveBeenCalledTimes(1);
    expect(mocks.bots[1].launch).toHaveBeenCalledTimes(1);
  });
});
