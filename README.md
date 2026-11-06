# Scan & Print

A privacy-conscious QR upload pilot for a single print shop. Customers scan a shop QR code, upload files without WhatsApp or sharing a phone number, and the shopkeeper views/downloads them from a simple dashboard.

## Current pilot design

- Customer page: `/s/pilot-shop`
- Shopkeeper page: `/admin`
- Worker API, D1 metadata database and R2 temporary file storage
- Multiple files per order; uploads are sent individually to avoid one giant upload request
- 24-hour default retention (configurable)
- Shopkeeper can preview images, open PDFs, copy supported images, and download originals
- Dashboard refreshes automatically every 7 seconds

## Important limits and privacy notes

"No arbitrary file-count limit" does not mean infinite storage. The current pilot allows up to 250 MB per file and a configurable 500 MB total per order. Cloudflare account and plan limits also apply. Raise/lower these values only after testing and checking current Cloudflare limits.

Files are private in R2 and only served through the authenticated dashboard. The shopkeeper can still save or copy a file after viewing it; automatic expiry cannot erase copies already downloaded. Do not describe this as end-to-end encrypted or promise that the shop cannot retain a copy.

The current prototype is a pilot foundation, not yet production-hardened. Before real customer use, add rate limiting/abuse controls, stronger admin credential handling, upload completion checks, safer file type validation, ZIP download, and a tested scheduled cleanup trigger.

## Cloudflare setup

1. Create a Cloudflare Worker named `scan-print` and connect this GitHub repository.
2. Create a D1 database named `scan-print-db`.
3. Create an R2 bucket named `scan-print-files`.
4. Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.toml` with the D1 database ID.
5. Run `wrangler d1 execute scan-print-db --remote --file=schema.sql`.
6. Add the Worker secret `ADMIN_PASSWORD` in Cloudflare. Use a strong, unique password.
7. Deploy. Add a Cron Trigger (for example, every hour) so expired files are cleaned up by the scheduled handler.
8. Test with non-sensitive sample files before giving the QR to a shop.

## QR code

After deployment, the pilot customer URL is:

`https://YOUR-WORKER-DOMAIN/s/pilot-shop`

Generate a QR code pointing to that exact URL. Do not print the QR until the deployed URL has been tested.

## Next development steps

- Confirm end-to-end deployment and D1/R2 bindings
- Add ZIP download and a clear upload-complete receipt
- Add resumable/retryable uploads and robust partial-order handling
- Validate file signatures and safely handle untrusted files
- Add an explicit delete button and improve expiry cleanup
