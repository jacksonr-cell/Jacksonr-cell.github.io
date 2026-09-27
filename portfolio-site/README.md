# Jackson Rotich portfolio

This repository serves the portfolio and its contact API from one Node.js service. GitHub remains the source of truth; GitHub Pages only serves static files and cannot run the API. `render.yaml` provides a Render deployment blueprint.

## Contact service setup

The contact form sends messages through Resend. Before deployment:

1. Create a Resend account and verify a sending domain you control. A Gmail address is the inbox destination; it cannot be used as the sender domain.
2. Create an Upstash Redis database for shared rate limiting across service instances.
3. Add these secrets in the hosting dashboard; do not commit them:
   - `RESEND_API_KEY`
   - `CONTACT_TO` (currently `JACKSONKIPCHUMBA001@gmail.com`)
   - `CONTACT_FROM` (a sender address on the verified domain)
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `ALLOWED_ORIGINS` (optional; include the exact public site origin if the frontend is hosted separately)
4. Choose a paid web-service plan for an always-on contact endpoint. Free Render web services spin down while idle.

The API accepts only JSON `POST /api/contact` requests, validates and bounds fields, limits request size, uses a honeypot and shared per-IP throttling, restricts browser origins, and keeps provider errors and secrets out of responses. `GET /healthz` is the host health check.

## Local development

Install dependencies with `pnpm install`, copy `.env.example` to `.env`, fill in the service values, then run `pnpm run build` and `pnpm start`. The same Node server serves the website and `/api/contact`.
