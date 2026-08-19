# V SHIROYA Policy AI

Insurance policy document intelligence and audit application.

## Features

- Upload PDF or policy images
- Server-side OpenRouter AI analysis
- Full-document OCR/extraction
- Structured policy fields, confidence, missing/uncertain fields
- Policy status calculation
- Policy storage, statistics and audit log APIs

## Local setup

Prerequisites: Node.js 20+

```bash
npm install
cp .env.example .env
```

Set a real `OPENROUTER_API_KEY` in `.env`.

Optional configuration:

- `OPENROUTER_MODELS` — comma-separated model fallback list
- `OPENROUTER_PDF_ENGINE` — PDF processing engine
- `APP_URL` — public application URL

Run development mode:

```bash
npm run dev
```

Build and run production mode:

```bash
npm run build
npm start
```

Health check: `GET /api/health`.

Policy analysis: `POST /api/analyze-policy` with JSON fields `fileData`, `fileName`, `mimeType`, and optional `instruction`.

## Render deployment

Create a Render Web Service from this repository with:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment: Node
- Environment variable: `OPENROUTER_API_KEY` (secret)
- Optional: `OPENROUTER_MODELS`, `OPENROUTER_PDF_ENGINE`, `APP_URL`

Do not commit `.env` or API keys. The included `.gitignore` excludes environment files except `.env.example`.

## Verification

After deployment, open `/api/health` and confirm `ok: true` and `configured: true`. Then upload a representative policy PDF from the UI and confirm structured extraction is returned.
