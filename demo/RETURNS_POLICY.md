# Revenue Recognition Policy

Defines how to compute **net revenue** from the order files. Apply exactly.

## Recognized (counts toward revenue)
An order line counts **only** when the order `status` is one of:
- `fulfilled`
- `delivered`

## Excluded (counts as zero)
- `returned`
- `refunded`
- `cancelled`
- `pending`

## Line revenue
`line_revenue = qty * unit_price` (unit_price is in dollars). Sum across all
recognized line items per product.

## Reporting period
"2025" = orders whose `date` is in calendar year 2025. The `orders-2024.json`
and `orders-2026.json` files are out of period and excluded regardless of status.
