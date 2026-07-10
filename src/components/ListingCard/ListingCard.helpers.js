import { displayPrice, isPriceVariationsEnabled } from '../../util/configHelpers';
import { formatMoney } from '../../util/currency';
import { richText } from '../../util/richText';
import { isBookingProcessAlias } from '../../transactions/transaction';
import { isNightlyUnitType, monthlyPriceFromNightly } from '../../util/monthlyPrice';

import css from './ListingCard.module.css';

const MIN_LENGTH_FOR_LONG_WORDS = 10;

const priceData = (price, currency, intl) => {
  if (price && price.currency === currency) {
    const formattedPrice = formatMoney(intl, price);
    return { formattedPrice, priceTooltip: formattedPrice };
  } else if (price) {
    return {
      formattedPrice: intl.formatMessage(
        { id: 'ListingCard.unsupportedPrice' },
        { currency: price.currency }
      ),
      priceTooltip: intl.formatMessage(
        { id: 'ListingCard.unsupportedPriceTitle' },
        { currency: price.currency }
      ),
    };
  }
  return {};
};

/**
 * Returns all translated and formatted strings for ListingCard so the
 * presentational component can stay simple and aria-labels use the same copy.
 *
 * @param {Object} listing - API entity: listing or ownListing
 * @param {Object} config - app configuration (e.g. from useConfiguration())
 * @param {Object} intl - React Intl instance (e.g. from useIntl())
 * @returns {Object} translations and derived values:
 *   - titlePlain: raw title string (for aria/alt)
 *   - titleFormatted: React nodes from richText(title) for display
 *   - showPrice: whether to show the price block
 *   - priceTooltip: string for the price element's title attribute (tooltip on hover)
 *   - priceMessage: string or null for the price block content (same translation as used in cardAriaLabel when shown)
 *   - cardAriaLabel: ready-to-use aria-label for the card link (listing title + price line when shown)
 *   - authorName: "ListingCard.author" string containing author's display name
 */
export const getListingCardTranslations = (listing, config, intl) => {
  const { title = '', price, publicData } = listing?.attributes || {};

  const authorDisplayName = listing?.author?.attributes?.profile?.displayName;
  const authorName = intl.formatMessage(
    { id: 'ListingCard.author' },
    { authorName: authorDisplayName }
  );

  const validListingTypes = config.listing.listingTypes || [];
  const { listingType } = publicData || {};
  const listingTypeConfig = validListingTypes.find(conf => conf.listingType === listingType);

  const showPrice = displayPrice(listingTypeConfig);
  // MOVE : les annonces "night" affichent un prix par mois (nuit x 30)
  const isNightly = isNightlyUnitType(publicData?.unitType);
  const displayedPrice = isNightly ? monthlyPriceFromNightly(price) : price;
  const { formattedPrice, priceTooltip } = priceData(displayedPrice, config.currency, intl);

  const isPriceVariationsInUse = isPriceVariationsEnabled(publicData, listingTypeConfig);
  const hasMultiplePriceVariants = isPriceVariationsInUse && publicData?.priceVariants?.length > 1;
  const isBookable = isBookingProcessAlias(publicData?.transactionProcessAlias);

  const priceMessageId = hasMultiplePriceVariants
    ? 'ListingCard.priceStartingFrom'
    : 'ListingCard.price';

  const perUnitString = isBookable
    ? isNightly
      ? intl.formatMessage({ id: 'ListingCard.perMonth' })
      : intl.formatMessage({ id: 'ListingCard.perUnit' }, { unitType: publicData?.unitType })
    : '';

  // Single formatted price line (amount + per-unit if applicable); used for both card aria and price block
  const priceValue = <span className={css.priceValue}>{formattedPrice}</span>;
  const pricePerUnit = isBookable ? <span className={css.perUnit}>{perUnitString}</span> : '';
  const priceMessage =
    showPrice && formattedPrice != null
      ? intl.formatMessage({ id: priceMessageId }, { priceValue, pricePerUnit })
      : '';

  const cardAriaLabel =
    priceMessage.length > 0
      ? intl.formatMessage(
          { id: 'ListingCard.screenreader.label' },
          { listingTitle: title, formattedPrice: priceMessage }
        )
      : title;

  return {
    titlePlain: title,
    titleFormatted: richText(title, {
      longWordMinLength: MIN_LENGTH_FOR_LONG_WORDS,
      longWordClass: css.longWord,
    }),
    authorName,
    showPrice,
    priceTooltip,
    priceMessage,
    cardAriaLabel,
  };
};
