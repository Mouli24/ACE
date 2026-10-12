import type { ProviderType } from '@ace/contracts';

import { th, themeProviderOf } from '../theme/constants';
import { useThemeMode } from '../theme/mode';
import { ProviderOrb } from '../theme/primitives';

/**
 * A provider's identity as the theme draws it in lists and dropdowns (D328): its 20px orb with the
 * 11px logo and the icon ring, in the light or dark look. Decorative — the name beside it says it.
 */
export function ProviderMark({ type }: { type: ProviderType | null | undefined }) {
  const { dark } = useThemeMode();
  return (
    <ProviderOrb look={th(themeProviderOf(type), dark)} size={20} logo={11} shadow="iconRing" />
  );
}
