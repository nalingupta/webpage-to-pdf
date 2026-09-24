# Webpage to PDF

A Replit pnpm-workspace app that captures public webpages as PDFs, expands supported disclosures and carousels, and displays selectable PDF text and links in the preview.

- `artifacts/webpage-to-pdf`: React/Vite frontend
- `artifacts/api-server`: PDF capture API and tests
- `lib`: shared API types and generated clients

The Replit workflows set the required `PORT` and `BASE_PATH` variables and route `/api` to the API server. Outside Replit, provide those variables and a reverse proxy that routes `/api` to the backend. Chromium is required for capture.

Install with `pnpm install`. Run checks with `pnpm --filter @workspace/api-server run typecheck` and `pnpm --filter @workspace/webpage-to-pdf run typecheck`.
