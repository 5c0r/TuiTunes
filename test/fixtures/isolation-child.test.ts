import { test } from 'bun:test';
import { closeDb, initDb } from '../../src/db/index';
import { DEFAULT_CONFIG, saveConfig } from '../../src/utils/config';
import { Logger } from '../../src/utils/logger';

test.skipIf(process.env.TUITUNES_ISOLATION_CHILD !== '1')(
  'writes only inside preload sandbox',
  () => {
    saveConfig(DEFAULT_CONFIG);
    initDb();
    Logger.init();
    Logger.info('isolated probe');
    closeDb();
  },
);
