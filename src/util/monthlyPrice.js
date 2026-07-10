/**
 * MOVE (France Room) : affichage du prix mensuel.
 *
 * Les annonces Move utilisent l'unite "night" (contrainte no-code Sharetribe),
 * avec prix par nuit = loyer mensuel / 30. Pour l'affichage grand public,
 * on reconvertit en prix par mois (x30).
 */
import { types as sdkTypes } from './sdkLoader';

const { Money } = sdkTypes;

export const NIGHTS_PER_MONTH = 30;

export const isNightlyUnitType = unitType => unitType === 'night';

export const monthlyPriceFromNightly = price =>
  price ? new Money(price.amount * NIGHTS_PER_MONTH, price.currency) : null;
