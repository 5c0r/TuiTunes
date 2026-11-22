import { describe, expect, test } from 'bun:test';
import {
  isMpvEvent,
  isMpvResponse,
  normalizeAudioBackend,
  type MpvMessage,
  OBSERVED_PROPERTIES,
  parsePlaylistEntryId,
} from '../../src/player/types';

describe('isMpvEvent', () => {
  test('true for property-change event', () => {
    const msg: MpvMessage = { event: 'property-change', id: 1, name: 'time-pos', data: 42.5 };
    expect(isMpvEvent(msg)).toBe(true);
  });

  test('true for end-file event (no request_id)', () => {
    const msg = { event: 'end-file', reason: 'eof' } as MpvMessage;
    expect(isMpvEvent(msg)).toBe(true);
  });

  test('true for hybrid msg with both event and request_id — event takes precedence', () => {
    const msg = {
      event: 'property-change',
      request_id: 1,
      id: 1,
      name: 'pause',
      data: true,
    } as MpvMessage;
    expect(isMpvEvent(msg)).toBe(true);
  });

  test('false for response message', () => {
    const msg: MpvMessage = { error: 'success', data: null, request_id: 5 };
    expect(isMpvEvent(msg)).toBe(false);
  });
});

describe('isMpvResponse', () => {
  test('true for success response', () => {
    const msg: MpvMessage = { error: 'success', data: 42, request_id: 1 };
    expect(isMpvResponse(msg)).toBe(true);
  });

  test('true for error response', () => {
    const msg: MpvMessage = { error: 'property unavailable', request_id: 2 };
    expect(isMpvResponse(msg)).toBe(true);
  });

  test('false for event message', () => {
    const msg: MpvMessage = { event: 'property-change', id: 1, name: 'time-pos', data: 42.5 };
    expect(isMpvResponse(msg)).toBe(false);
  });

  test('false for hybrid message (has both event and request_id)', () => {
    const msg = {
      event: 'property-change',
      request_id: 1,
      id: 1,
      name: 'pause',
      data: true,
    } as MpvMessage;
    expect(isMpvResponse(msg)).toBe(false);
  });
});

describe('OBSERVED_PROPERTIES', () => {
  test('has 15 entries', () => {
    expect(OBSERVED_PROPERTIES).toHaveLength(15);
  });

  test('ids are unique integers 1..15', () => {
    const ids = OBSERVED_PROPERTIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(15);
    for (let i = 1; i <= 15; i++) {
      expect(ids).toContain(i);
    }
  });

  test('observer 14 is current-ao', () => {
    expect(OBSERVED_PROPERTIES[13]).toEqual({ id: 14, name: 'current-ao' });
  });

  test('observer 15 is seekable', () => {
    expect(OBSERVED_PROPERTIES[14]).toEqual({ id: 15, name: 'seekable' });
  });
});

describe('parsePlaylistEntryId', () => {
  test('accepts nonnegative safe integers', () => {
    expect(parsePlaylistEntryId(0)).toBe(0);
    expect(parsePlaylistEntryId(1)).toBe(1);
    expect(parsePlaylistEntryId(9007199254740991)).toBe(9007199254740991);
  });

  test('rejects malformed identities', () => {
    for (const bad of [
      -1,
      1.5,
      '3',
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      true,
    ]) {
      expect(parsePlaylistEntryId(bad)).toBeNull();
    }
  });
});

describe('normalizeAudioBackend', () => {
  test('maps capture-capable backends', () => {
    expect(normalizeAudioBackend('pipewire')).toBe('pipewire');
    expect(normalizeAudioBackend('pulse')).toBe('pulse');
    expect(normalizeAudioBackend('pulseaudio')).toBe('pulse');
    expect(normalizeAudioBackend('coreaudio')).toBe('coreaudio');
  });

  test('any other named output is unsupported; absent reports are null', () => {
    expect(normalizeAudioBackend('alsa')).toBe('unsupported');
    expect(normalizeAudioBackend('null')).toBe('unsupported');
    expect(normalizeAudioBackend('jack')).toBe('unsupported');
    expect(normalizeAudioBackend('')).toBeNull();
    expect(normalizeAudioBackend('   ')).toBeNull();
    expect(normalizeAudioBackend(undefined)).toBeNull();
    expect(normalizeAudioBackend(42)).toBeNull();
  });
});
