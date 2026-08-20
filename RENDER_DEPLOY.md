# Render deployment

This repository uses a single production root. Do not set Render Root Directory to `src`.

## Local CMD verification

```cmd
npm install
npm run lint
npm run build
npm start
```

Open `http://localhost:3000`.

Health check:

```text
http://localhost:3000/api/health
```

## Render Web Service

- Root Directory: leave empty / repository root
- Runtime: Node
- Node version: 20
- Build Command: `npm install --no-audit --no-fund && npm run build`
- Start Command: `npm start`
- Health Check Path: `/api/health`
- Required environment variable: `OPENROUTER_API_KEY`

Optional environment variables:

- `OPENROUTER_MODELS=google/gemini-2.5-flash`
- `OPENROUTER_PDF_ENGINE=mistral-ocr`
- `APP_URL=https://YOUR-SERVICE.onrender.com`

## Render CLI

After installing the Render CLI and authenticating:

```cmd
render blueprints validate render.yaml
render services
render deploys create SERVICE_ID --wait
```

The service must be connected to this GitHub repository and the `main` branch. The `render.yaml` file is the canonical Render configuration.
