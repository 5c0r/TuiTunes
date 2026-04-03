import { useAtomValue } from 'jotai';
import { themeNameAtom } from '../store/ui';
import { type Theme, getTheme } from './themes';

/** Read the active theme from the Jotai store. */
export function useTheme(): Theme {
  const name = useAtomValue(themeNameAtom);
  return getTheme(name);
}
