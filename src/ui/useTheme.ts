import { useAtomValue } from 'jotai';
import { themeNameAtom } from '../store/ui';
import { getTheme, type Theme } from './themes';

/** Read the active theme from the Jotai store. */
export function useTheme(): Theme {
  const name = useAtomValue(themeNameAtom);
  return getTheme(name);
}
