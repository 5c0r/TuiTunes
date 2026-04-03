import { describe, test, expect } from 'bun:test';
import {
  isMpvEvent,
  isMpvResponse,
  OBSERVED_PROPERTIES,
  type MpvMessage,
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
    const msg = { event: 'property-change', request_id: 1, id: 1, name: 'pause', data: true } as MpvMessage;
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
    const msg = { event: 'property-change', request_id: 1, id: 1, name: 'pause', data: true } as MpvMessage;
    expect(isMpvResponse(msg)).toBe(false);
  });
});

describe('OBSERVED_PROPERTIES', () => {
  test('has 13 entries', () => {
    expect(OBSERVED_PROPERTIES).toHaveLength(13);
  });

  test('ids are unique integers 1..13', () => {
    const ids = OBSERVED_PROPERTIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(13);
    for (let i = 1; i <= 13; i++) {
      expect(ids).toContain(i);
    }
  });
});
