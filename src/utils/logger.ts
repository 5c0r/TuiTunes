import { appendFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

import { CONFIG_DIR as LOG_DIR } from './config';

const LOG_PATH = path.join(LOG_DIR, 'debug.log');

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function write(level: LogLevel, msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  appendFileSync(LOG_PATH, line, 'utf-8');
}

export class Logger {
  static init(): void {
    mkdirSync(LOG_DIR, { recursive: true });
  }

  static info(msg: string): void {
    write('INFO', msg);
  }

  static warn(msg: string): void {
    write('WARN', msg);
  }

  static error(msg: string): void {
    write('ERROR', msg);
  }

  static debug(msg: string): void {
    write('DEBUG', msg);
  }
}
