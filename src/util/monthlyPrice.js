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

// Arrondi a l'euro pour l'affichage (les prix nuit = loyer/30 creent des centimes).
// Le detail exact (nuit x nombre de nuits) reste visible au checkout.
export const monthlyPriceFromNightly = price =>
  price
    ? new Money(Math.round((price.amount * NIGHTS_PER_MONTH) / 100) * 100, price.currency)
    : null;
