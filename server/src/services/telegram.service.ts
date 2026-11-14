import { Telegraf, Markup } from 'telegraf';
import { exec } from 'child_process';
import { logger } from '../utils/logger';
import { config } from '../config';
import { rpcService } from './rpc.service';
import { Block } from '../models/Block';
import { ProviderTagSubmission } from '../models/ProviderTagSubmission';
import { ProviderTag } from '../models/ProviderTag';
import { clearProviderTagCache } from './providerTag.service';

const BLOCK_STALL_MS = 20 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

class TelegramService {
  private bot: Telegraf | null = null;
  private adminId: number = 0;
  private lastBlockSeenAt = Date.now();
  private stallAlertSent = false;
  private checkTimer: NodeJS.Timeout | null = null;
  private enabled = false;

  start(): void {
    const token = config.telegram.botToken;
    this.adminId = config.telegram.adminId;

    if (!token || !this.adminId) {
      logger.info('Telegram bot disabled (TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_ID not set)');
      return;
    }

    // Started already (start runs again after a database reconnect): a second bot would compete
    // for the same updates and send every alert twice.
    if (this.bot) return;

    this.bot = new Telegraf(token);
    this.enabled = true;
    this.registerCommands();
    this.registerActions();

    this.bot.launch().catch((err) => logger.error('Telegram bot launch error', err));
    this.checkTimer = setInterval(() => this.checkBlockStall(), CHECK_INTERVAL_MS);

    process.once('SIGINT', () => this.bot?.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot?.stop('SIGTERM'));

    logger.info('Telegram bot started');
  }

  stop(): void {
    this.bot?.stop();
    this.bot = null;
    this.enabled = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  notifyNewBlock(height: number): void {
    if (!this.enabled) return;
    const wasStalled = this.stallAlertSent;
    this.lastBlockSeenAt = Date.now();
    this.stallAlertSent = false;

    if (wasStalled) {
      this.sendToAdmin(`✅ Sync recovered\\. Latest block: *\\#${height}*`).catch(() => {});
    }
  }

  async notifyProviderTagSubmission(sub: {
    id: string;
    cidr: string;
    provider: string;
    reporter?: string | null;
    contact?: string | null;
    evidenceUrl?: string | null;
    notes?: string | null;
  }): Promise<void> {
    if (!this.bot || !this.adminId) return;

    const lines = [
      '📋 *New provider tag submission*',
      '',
      `🌐 CIDR: \`${escapeMarkdown(sub.cidr)}\``,
      `🏢 Provider: ${escapeMarkdown(sub.provider)}`,
    ];
    if (sub.reporter) lines.push(`👤 Reporter: ${escapeMarkdown(sub.reporter)}`);
    if (sub.contact) lines.push(`📧 Contact: ${escapeMarkdown(sub.contact)}`);
    if (sub.evidenceUrl) lines.push(`🔗 Evidence: ${escapeMarkdown(sub.evidenceUrl)}`);
    if (sub.notes) lines.push(`📝 Notes: ${escapeMarkdown(sub.notes)}`);

    try {
      await this.bot.telegram.sendMessage(this.adminId, lines.join('\n'), {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          Markup.button.callback('✅ Approve', `approve:${sub.id}`),
          Markup.button.callback('❌ Reject', `reject:${sub.id}`),
        ]),
      });
    } catch (err) {
      logger.error('Telegram notifyProviderTagSubmission error', err);
    }
  }

  async sendToAdmin(text: string): Promise<void> {
    if (!this.bot || !this.adminId) return;
    try {
      await this.bot.telegram.sendMessage(this.adminId, text, { parse_mode: 'MarkdownV2' });
    } catch (err) {
      logger.error('Telegram sendToAdmin error', err);
    }
  }

  private async checkBlockStall(): Promise<void> {
    if (!this.enabled || this.stallAlertSent) return;
    const elapsed = Date.now() - this.lastBlockSeenAt;
    if (elapsed > BLOCK_STALL_MS) {
      this.stallAlertSent = true;
      const minutes = Math.round(elapsed / 60000);
      await this.sendToAdmin(
        `⚠️ *Warning\\!*\n\nThe last block arrived *${minutes} minutes ago*\\.\nThe explorer may be down, or the daemon is not syncing\\!`
      ).catch(() => {});
    }
  }

  private registerActions(): void {
    if (!this.bot) return;

    this.bot.action(/^approve:(.+)$/, async (ctx) => {
      if (ctx.from?.id !== this.adminId) return ctx.answerCbQuery('⛔ Not authorized.');

      const id = ctx.match[1];
      try {
        const sub = await ProviderTagSubmission.findById(id);
        if (!sub) return ctx.answerCbQuery('❌ Submission not found.');
        if (sub.status !== 'pending') {
          return ctx.answerCbQuery(`Already handled: ${sub.status}`);
        }

        const tag = await ProviderTag.findOneAndUpdate(
          { cidr: sub.cidr, provider: sub.provider },
          {
            cidr: sub.cidr,
            provider: sub.provider,
            source: sub.source || 'operator_reported',
            confidence:
              typeof sub.confidence === 'number' && Number.isFinite(sub.confidence)
                ? Math.round(sub.confidence)
                : 85,
            reporter: sub.reporter || null,
            evidenceUrl: sub.evidenceUrl || null,
            active: true,
          },
          { upsert: true, new: true }
        );

        await ProviderTagSubmission.findByIdAndUpdate(id, {
          status: 'approved',
          reviewer: 'telegram-admin',
          reviewedAt: new Date(),
          resolvedTagId: tag._id,
        });
        clearProviderTagCache();

        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.answerCbQuery('✅ Approved and activated!');
        await ctx.reply(`✅ Approved: ${sub.cidr} — ${sub.provider}`);
      } catch (err) {
        logger.error('Telegram approve action error', err);
        await ctx.answerCbQuery('❌ Something went wrong.');
      }
    });

    this.bot.action(/^reject:(.+)$/, async (ctx) => {
      if (ctx.from?.id !== this.adminId) return ctx.answerCbQuery('⛔ Not authorized.');

      const id = ctx.match[1];
      try {
        const sub = await ProviderTagSubmission.findById(id);
        if (!sub) return ctx.answerCbQuery('❌ Submission not found.');
        if (sub.status !== 'pending') {
          return ctx.answerCbQuery(`Already handled: ${sub.status}`);
        }

        await ProviderTagSubmission.findByIdAndUpdate(id, {
          status: 'rejected',
          reviewer: 'telegram-admin',
          reviewedAt: new Date(),
        });

        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.answerCbQuery('❌ Rejected.');
        await ctx.reply(`❌ Rejected: ${sub.cidr} — ${sub.provider}`);
      } catch (err) {
        logger.error('Telegram reject action error', err);
        await ctx.answerCbQuery('❌ Something went wrong.');
      }
    });
  }

  private registerCommands(): void {
    if (!this.bot) return;

    this.bot.use((ctx, next) => {
      if (ctx.from?.id !== this.adminId) {
        return ctx.reply('⛔ Not authorized.');
      }
      return next();
    });

    this.bot.command('start', async (ctx) => {
      await ctx.reply('🤖 *DeFCoN Explorer Bot*\n\nSend /help to list the available commands.', {
        parse_mode: 'Markdown',
      });
    });

    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        '🤖 *DeFCoN Explorer Bot*\n\n' +
          'Commands:\n' +
          '/status — Explorer and daemon status\n' +
          '/daemonstatus — DeFCoN daemon details (if configured)\n' +
          '/mn — Masternode summary\n' +
          '/restart — Restart the explorer\n' +
          '/reindex — Stop the daemon and start a reindex (if configured)',
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('status', async (ctx) => {
      try {
        const [chainInfo, lastBlock] = await Promise.all([
          rpcService.getBlockchainInfo() as Promise<{ blocks?: number; initialblockdownload?: boolean }>,
          Block.findOne().sort({ height: -1 }).select({ height: 1, time: 1 }).lean<{ height: number; time: number }>(),
        ]);

        const ageMin = lastBlock ? Math.round((Date.now() / 1000 - lastBlock.time) / 60) : null;
        const synced = chainInfo?.initialblockdownload === false ? '✅ Yes' : '⏳ Syncing...';

        const lines = [
          '🤖 *DeFCoN Explorer Status*',
          '',
          `📦 Latest DB block: *#${lastBlock?.height ?? '?'}*`,
          `⚒ Daemon block: *#${chainInfo?.blocks ?? '?'}*`,
          `⏱ Block age: *${ageMin !== null ? ageMin + ' min' : 'unknown'}*`,
          `🔄 Synced: *${synced}*`,
        ];

        await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
      } catch {
        await ctx.reply('❌ Failed to fetch the status.');
      }
    });

    this.bot.command('mn', async (ctx) => {
      try {
        const mnRaw = await rpcService.call<Record<string, string>>('masternodelist', ['full']);
        const entries = Object.values(mnRaw ?? {});
        const total = entries.length;
        const enabled = entries.filter((val) => {
          const status = String(val).trimStart().split(/\s+/)[0]?.toUpperCase();
          return status === 'ENABLED' || status === 'POSE_PENALTY';
        }).length;

        // Legacy Markdown: a bare "_" opens an italic entity, so escape it.
        await ctx.reply(
          `Masternodes\n\nActive (ENABLED + POSE\\_PENALTY): *${enabled}*\nTotal: *${total}*`,
          { parse_mode: 'Markdown' }
        );
      } catch {
        await ctx.reply('❌ Failed to fetch the masternode list.');
      }
    });

    this.bot.command('restart', async (ctx) => {
      await ctx.reply('🔄 Restarting the explorer... (back in about 5 seconds)');
      setTimeout(() => process.exit(0), 1500);
    });

    // /reindex and /daemonstatus run operator-supplied shell commands because the
    // daemon's service layout differs per host. Both stay disabled until configured.
    this.bot.command('reindex', async (ctx) => {
      const command = config.telegram.reindexCommand;
      if (!command) {
        await ctx.reply('ℹ️ /reindex is not configured (TELEGRAM_REINDEX_COMMAND is empty).');
        return;
      }
      await ctx.reply('🔄 Stopping the daemon and starting a reindex...');
      exec(command, (err) => {
        if (err) {
          this.sendToAdmin(`❌ Failed to start the reindex: ${escapeMarkdown(err.message)}`).catch(() => {});
        } else {
          this.sendToAdmin('✅ Reindex started\\. Syncing may take several hours\\.').catch(() => {});
        }
      });
    });

    this.bot.command('daemonstatus', async (ctx) => {
      const command = config.telegram.daemonStatusCommand;
      if (!command) {
        await ctx.reply('ℹ️ /daemonstatus is not configured (TELEGRAM_DAEMON_STATUS_COMMAND is empty).');
        return;
      }
      exec(command, (err, stdout) => {
        const output = stdout.trim().slice(0, 3500) || (err ? err.message : '') || 'no output';
        ctx.reply(`🖥️ Daemon status\n\n${output}`).catch(() => {});
      });
    });
  }
}

export const telegramService = new TelegramService();
