import config from 'config';
import { BaseConfig, DexareClient } from 'dexare';
import { iterateFolder } from 'dexare/lib/util';
import Eris from 'eris';
import path from 'node:path';
import { SlashCreatorOptions } from 'slash-create';

import { init as i18nInit } from './i18n';
import { cron as influxCron } from './influx';
import AutorecordModule from './modules/autorecord';
import LoggerModule from './modules/logger';
import RecorderModule from './modules/recorder';
import ShardingModule from './modules/sharding';
import SlashModule from './modules/slash';
import { prisma } from './prisma';
import { client as redisClient } from './redis';
import { close as closeSentry } from './sentry';
import { version } from './util';

export const PRODUCTION = process.env.NODE_ENV === 'production';

export interface CraigBotConfig extends BaseConfig {
  applicationID: string;
  prefix: string | string[];
  mentionPrefix: boolean;
  status: Eris.ActivityPartial<Eris.BotActivityType>;

  craig: {
    emoji: string;
    downloadDomain: string;
    homepage: string;
    recordingFolder: string;
    removeNickname: boolean;
    sizeLimit: number;
    sizeLimitWeb: number;
    sizeLimitWebOpus: number;
    inviteID?: string;
    webapp: {
      on: boolean;
      url: string;
      token: string;
      connectUrl: string;
    };
    rewardTiers: { [tier: string]: RewardTier };
  };

  logger: {
    level: string;
    inspectOptions?: any;
  };

  slash: {
    creator?: SlashCreatorOptions;
  };
}

export interface RewardTier {
  recordHours: number;
  downloadExpiryHours: number;
  features: string[];
}

export class CraigBot extends DexareClient<CraigBotConfig> {
  _shard?: Eris.Shard;

  constructor(config: CraigBotConfig) {
    super(config);
  }

  get shard() {
    if (!this._shard) this._shard = this.bot.shards.values().next().value;
    return this._shard;
  }

  get prisma() {
    return prisma;
  }

  get version() {
    return version;
  }
}

const dexareConfig = Object.assign({}, config.get('dexare')) as CraigBotConfig;
if (process.env.SHARD_ID !== undefined && process.env.SHARD_COUNT !== undefined) {
  dexareConfig.erisOptions = Object.assign({}, dexareConfig.erisOptions, {
    firstShardID: parseInt(process.env.SHARD_ID, 10),
    lastShardID: parseInt(process.env.SHARD_ID, 10),
    maxShards: parseInt(process.env.SHARD_COUNT, 10)
  });
}
export const client = new CraigBot(dexareConfig);

process.once('SIGINT', async () => {
  client.emit('logger', 'warn', 'sys', ['Caught SIGINT']);
  await client.disconnect();
  process.exit(0);
});

process.once('beforeExit', async () => {
  client.emit('logger', 'warn', 'sys', ['Exiting....']);
  await client.disconnect();
  process.exit(0);
});

process.on('unhandledRejection', (r) => {
  client.emit('logger', 'error', 'sys', ['Unhandled rejection:', r]);
});

process.on('uncaughtException', (e) => {
  client.emit('logger', 'error', 'sys', ['Uncaught exception:', e]);
});

export async function connect() {
  client.loadModules(LoggerModule, SlashModule, ShardingModule, RecorderModule, AutorecordModule);
  client.commands.registerDefaults(['eval', 'ping', 'kill', 'exec', 'load', 'unload', 'reload']);

  // Makes custom emojis with the name 'craig' work as prefixes
  client.events.register(
    'prefixer',
    'messageCreate',
    (event, message) => {
      if (/^<a?:craig:\d+>,?/.test(message.content)) event.set('prefix', message.content.match(/^<a?:craig:\d+>,?/)![0]);
    },
    { after: ['commands'] }
  );

  await i18nInit();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  await iterateFolder(path.join(__dirname, config.get('commandsPath' as string)), async (file) => client.commands.register(require(file)));
  await redisClient.connect();
  await client.connect();
  await prisma.$connect();
  influxCron.start();
  client.bot.editStatus('online', client.config.status);
}

export async function disconnect() {
  await client.disconnect();
  await closeSentry();
  await prisma.$disconnect();
  redisClient.disconnect();
}
