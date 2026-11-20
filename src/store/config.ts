import { atom } from 'jotai';
import { DEFAULT_CONFIG, type TuiTunesConfig } from '../utils/config';

export const configAtom = atom<TuiTunesConfig>({ ...DEFAULT_CONFIG });
