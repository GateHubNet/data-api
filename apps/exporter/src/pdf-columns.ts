/** A column of the table of a PDF export: a column of the list's CSV, and its share of the page's width. */
export interface PdfColumn {
  /** The column of the CSV, as the list names it (`executed_time`). */
  name: string;
  /** Its width relative to the others of the table: the table fills the page's width in these proportions. */
  width: number;
}

const column = (name: string, width: number): PdfColumn => ({ name, width });

// The widths are about the points a value takes in the table's 6 pt font, plus some room: a time 104, an address 140,
// an amount 60. A transaction hash gets 136, half of what it needs: it takes two lines, since no table of this many
// columns fits a whole hash on the width of a landscape page.

const PAYMENTS = [
  column('executed_time', 104),
  column('ledger_index', 44),
  column('source', 140),
  column('destination', 140),
  column('destination_tag', 50),
  column('delivered_amount', 60),
  column('currency', 36),
  column('issuer', 140),
  column('tx_hash', 136),
];

const EXCHANGES = [
  column('executed_time', 104),
  column('ledger_index', 44),
  column('base_amount', 60),
  column('base_currency', 36),
  column('base_issuer', 140),
  column('counter_amount', 60),
  column('counter_currency', 36),
  column('counter_issuer', 140),
  column('rate', 60),
  column('buyer', 140),
  column('seller', 140),
  column('tx_hash', 136),
];

const PATH_PAYMENTS = [
  column('executed_time', 104),
  column('ledger_index', 44),
  column('source', 140),
  column('destination', 140),
  column('delivered_amount', 60),
  column('currency', 36),
  column('issuer', 140),
  column('source_amount', 60),
  column('source_currency', 36),
  column('offers_crossed', 40),
  column('hash', 136),
];

/**
 * The columns a PDF export shows of each exportable list, by the list's route (`:param` matches any one segment): the
 * ones an investigator reads on paper. The CSV keeps every column. A list that is not here shows its first
 * `PDF_FALLBACK_COLUMNS` columns, of equal width (`pdfColumnsOf`).
 *
 * A column named here that no row of the list has is shown empty.
 */
export const PDF_COLUMNS: Record<string, PdfColumn[]> = {
  '/v2/accounts/:address/transactions': [
    column('ledger_index', 44),
    column('executed_time', 104),
    column('tx_type', 58),
    column('result', 54),
    column('counterparty', 140),
    column('amount', 60),
    column('currency', 36),
    column('issuer', 140),
    column('fee', 40),
    column('flags_changed', 56),
    column('hash', 136),
  ],
  '/v2/accounts/:address/payments': PAYMENTS,
  '/v2/payments': PAYMENTS,
  '/v2/payments/:currency': PAYMENTS,
  '/v2/accounts/:address/exchanges': EXCHANGES,
  '/v2/accounts/:address/exchanges/:base': EXCHANGES,
  '/v2/accounts/:address/exchanges/:base/:counter': EXCHANGES,
  '/v2/accounts/:address/balance_changes': [
    column('executed_time', 104),
    column('ledger_index', 44),
    column('change_type', 60),
    column('currency', 36),
    column('counterparty', 140),
    column('amount_change', 60),
    column('final_balance', 60),
    column('tx_hash', 136),
  ],
  '/v2/accounts/:address/balances': [column('currency', 36), column('counterparty', 140), column('value', 60)],
  // every setting of a line: the fallback's first 8 columns would leave out the freezes and the qualities
  '/v2/accounts/:address/trustlines': [
    column('currency', 36),
    column('counterparty', 140),
    column('balance', 60),
    column('limit', 60),
    column('limit_peer', 60),
    column('no_ripple', 34),
    column('no_ripple_peer', 44),
    column('authorized', 40),
    column('peer_authorized', 48),
    column('freeze', 30),
    column('peer_freeze', 40),
    column('quality_in', 40),
    column('quality_out', 40),
  ],
  '/v2/accounts': [
    column('inception', 104),
    column('ledger_index', 44),
    column('account', 140),
    column('parent', 140),
    column('initial_balance', 60),
    column('tx_hash', 136),
  ],
  '/v2/path_payments': PATH_PAYMENTS,
  '/v2/accounts/:address/path_payments': PATH_PAYMENTS,
};

/** How many of its first columns a list without its own choice in `PDF_COLUMNS` shows. */
export const PDF_FALLBACK_COLUMNS = 8;

const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s !== '');

/** The columns of the PDF of the list at `pathname` (`/v2/…`, no query) whose CSV has the columns `csvColumns`. */
export function pdfColumnsOf(pathname: string, csvColumns: string[]): PdfColumn[] {
  const segments = segmentsOf(pathname);
  for (const [route, columns] of Object.entries(PDF_COLUMNS)) {
    const pattern = segmentsOf(route);
    if (pattern.length === segments.length && pattern.every((s, i) => s.startsWith(':') || s === segments[i])) {
      return columns;
    }
  }
  return csvColumns.slice(0, PDF_FALLBACK_COLUMNS).map((name) => column(name, 1));
}
