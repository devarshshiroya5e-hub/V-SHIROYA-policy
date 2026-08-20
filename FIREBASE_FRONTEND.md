# Firebase frontend + Render backend

The backend remains on Render:

`https://v-shiroya-policy.onrender.com`

The React/Vite frontend can be deployed to Firebase Hosting. The frontend sends analysis requests to the Render backend using `VITE_API_BASE_URL`.

## CMD deployment

From the repository root:

```cmd
npm install
set VITE_API_BASE_URL=https://v-shiroya-policy.onrender.com
npm run build
npx firebase-tools login
npx firebase-tools use --add
npx firebase-tools deploy --only hosting
```

When `firebase-tools use --add` asks for the project, select your Firebase project. Do not commit a real `.firebaserc` containing secrets; Firebase project IDs are not secrets, but keeping the local file is simpler.

## Render backend environment

Set these variables on Render:

```text
OPENROUTER_API_KEY=YOUR_REAL_OPENROUTER_KEY
OPENROUTER_MODELS=google/gemini-2.5-flash
OPENROUTER_PDF_ENGINE=mistral-ocr
APP_URL=https://v-shiroya-policy.onrender.com
FRONTEND_URL=https://YOUR-FIREBASE-DOMAIN.web.app
FIREBASE_APP_URL=https://YOUR-FIREBASE-DOMAIN.web.app
```

For a custom Firebase domain, use that exact HTTPS origin instead.

## Important

- The OpenRouter key stays only on Render.
- The Firebase frontend never receives the OpenRouter key.
- PDFs/images are sent from the browser to `POST /api/analyze-policy` on Render.
- Render sends the file to OpenRouter for OCR/analysis and returns structured JSON to the browser.
- OpenRouter's PDF `file` input and `mistral-ocr` parser support scanned/image-only PDFs. See the OpenRouter PDF documentation for current limits and pricing.
