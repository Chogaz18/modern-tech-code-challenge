# ClearRow

ClearRow is a one-day CSV cleanup demo. You upload a file, review deterministic data-quality findings, optionally ask a model for more suggestions, accept or reject each change, and download a CSV that contains only the edits you accepted.

Original rows stay immutable in memory. The spreadsheet is not written to a database. `analyzeCsv` stores only a daily request counter for the anonymous sign-in.

## Five-minute demo

1. Install and start the app (commands below). A model key is not required.
2. Choose **Load sample**. The bundled file includes blank cells, exact duplicate rows, surrounding spaces, inconsistent casing, a quoted comma, placeholder values, invalid-looking emails, and formula-like cells.
3. Read the overview chart. Every card in the review queue is badged **Rule**. Those findings are not model output.
4. Choose **Accept safe cleanups**. That accepts high-confidence trims and obvious casing fixes only. Missing values and duplicate rows stay flagged, with no replacement invented and no row deleted.
5. Turn on **Preview accepted edits**. Edited cells are marked. The original file in memory is unchanged.
6. **Download CSV**. Accepted edits are applied. Cells whose first non-space character is `=`, `+`, `-`, or `@` are prefixed with an apostrophe.
7. **Analyze with AI** stays disabled until Firebase and a model key are configured. The status text says that directly.

## Setup

Requirements: Node.js 20 or newer.

```bash
cd clearrow
npm install
npm install --prefix functions
```

Copy the example env file. Leave the values blank to run without AI:

```bash
copy .env.example .env
```

On macOS or Linux, use `cp .env.example .env`.

## Local run

```bash
npm run dev
```

Open the printed localhost URL. The sample is served from `public/sample-customers.csv`.

## Tests and build

```bash
npm test
npm run typecheck
npm run build
npm run functions:build
```

`npm test` covers CSV parsing, deterministic findings, AI suggestion rejection, accepted-edit application, formula-safe export, unauthenticated analysis calls, the daily analysis limit, and concurrent quota attempts. It does not call OpenAI or Anthropic.

## Firebase function

The browser never receives the model key. `VITE_*` variables only identify the Firebase project. The key is a Cloud Functions secret named `MODEL_API_KEY`. Do not put that key in any `VITE_` variable.

Callable functions, both in `us-central1`:

- `aiStatus` returns `{ available, provider }`. It stays callable without a signed-in user so the page can show whether analysis is configured. It does not reserve quota.
- `analyzeCsv` requires `request.auth.uid`. The Vue client signs in with Firebase Anonymous Authentication before the call. The function then validates the payload, reserves one daily request in a Firestore transaction, and only then calls the model. Suggestions still pass schema checks in the function and again in the browser.

Anonymous Authentication limits casual abuse. Each browser profile gets a uid, and that uid can run 10 analyses per UTC day. It does not provide a strong per-person identity: a private window or cleared site data creates another anonymous user and another daily quota. App Check and project-level budget controls are additional deployment safeguards. Turn on Firebase App Check for Hosting and Cloud Functions, and set a Google Cloud billing budget plus a spend limit in the model provider's console, before a public deploy.

The quota document is `analysisQuota/{uid}/days/{YYYY-MM-DD}` and stores the uid, the UTC day, and the count. Cell values are not stored. The reservation is committed before the model request, including when the model later fails, so overlapping calls cannot all read a stale count and pass the limit. Firestore rules deny every client read and write; the Admin SDK in the function bypasses those rules. A full quota returns `resource-exhausted` with the message `This sign-in has used all 10 AI analyses for the current UTC day. The limit resets at 00:00 UTC.`

### Configure the model

Create `functions/.env` from the example (these are non-secret parameters):

```bash
copy functions\.env.example functions\.env
```

```
AI_PROVIDER=openai
AI_MODEL=gpt-4o-mini
```

For Anthropic, set `AI_PROVIDER=anthropic` and `AI_MODEL=claude-3-5-haiku-latest`. Use a current model name if the default has been retired. One secret works for either provider:

```bash
npx firebase-tools@14 login
npx firebase-tools@14 use your-firebase-project-id
npx firebase-tools@14 functions:secrets:set MODEL_API_KEY
```

Do not invent a key. Paste the key from your OpenAI or Anthropic account when the CLI prompts. The command stores it in Google Secret Manager.

For the emulator, put the same key in `functions/.secret.local` (gitignored):

```
MODEL_API_KEY=paste-your-key-here
```

### Point the browser at the function

In the Firebase console, register a web app and copy its public config into `.env`:

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
VITE_USE_FUNCTIONS_EMULATOR=false
```

These values are client identifiers, not the model key. In the Firebase console, enable the Anonymous sign-in provider and create a Firestore database in Native mode. Anonymous sign-in is what attaches `request.auth.uid` to `analyzeCsv`.

### Emulator

```bash
npm run functions:build
npx firebase-tools@14 emulators:start --only auth,firestore,functions
```

In `.env`, set `VITE_USE_FUNCTIONS_EMULATOR=true` and `VITE_FIREBASE_PROJECT_ID` to the project id in `.firebaserc`. Restart `npm run dev`. That flag connects the Functions emulator on port 5001 and the Auth emulator on port 9099. The Functions emulator uses the Firestore emulator for the quota transaction when both are started together.

### Deploy

```bash
npm run build
npm run functions:build
npx firebase-tools@14 deploy --only functions,hosting,firestore:rules
```

`firebase.json` predeploy also runs the functions build. Hosting serves the Vite `dist/` folder. If a Windows predeploy shell rejects the command, run `npm run functions:build` yourself and deploy again; `functions/lib/index.js` must exist before the function is published. Deploy the Firestore rules in the same release so clients cannot change `analysisQuota`.

`maxInstances` is 5. The Cloud Run invoker stays public so the browser can call the functions. `analyzeCsv` still rejects a request that has no Firebase Auth uid. Anonymous sign-in, the daily cap, App Check, and provider or Google Cloud budget limits are the controls that keep a public demo from spending an open model budget.

## Architecture

```text
src/            Vue UI, session state, Firebase client
shared/         Pure TypeScript: parse, rules, validation, export, model pipeline
functions/src   Thin callable adapter. Secrets stay here.
public/         Sample CSV
```

Vue components do not decide whether a suggestion is valid. `shared/suggestions.ts` does. The function adapter calls `secureAnalyze`, which reserves the daily quota and then calls `runAnalysis`, and maps failures to `HttpsError`. Unit tests import `shared/` directly and pass a fake model client and an in-memory transaction store.

## What the rules do

| Check | Behavior |
| --- | --- |
| Empty cell | Flagged. No replacement is invented. |
| Placeholder such as `n/a` or `unknown` | Flagged as missing. No replacement is invented. |
| Exact duplicate row | Every copy is flagged. No row is deleted. |
| Surrounding whitespace | Proposed trim. High confidence. Included in **Accept safe cleanups**. |
| Casing on short, repeated columns | Proposed only when one spelling has at least 60% of that group and at least two occurrences. Bulk accept requires 75%. Ties and free-text columns, such as person names, are not rewritten. |
| Identifier columns | `id`, `*_id`, email, phone, SSN, and account columns can be flagged. They are never given a proposed edit. |
| Cells starting with `=` or `@` | Flagged as suspicious. No automatic replacement. |

Internal double spaces are left alone. `CDMX` versus `Mexico City` is intentionally not guessed by the rules; that is a model suggestion if you enable AI, and it still requires an explicit accept.

## AI payload tradeoff

The function accepts at most 40 rows and 180 characters per cell. Files inside that row limit are sent in full so the model can compare values. Larger files send rows that already have deterministic findings first, then fill the remaining slots in file order. Problems that exist only in omitted rows are not analyzed. Long cells are truncated and cannot receive a suggestion.

The raw file is not uploaded. Selected rows still include every column, including identifiers, because some inconsistencies only make sense with that context. Skip **Analyze with AI** if those values must not leave the browser. ClearRow does not store the row payload. The model provider still receives it, and Firestore receives only the anonymous uid and the daily count.

Cell text is placed in a JSON field labeled untrusted. The system prompt is static and does not include cell contents. A suggestion is dropped when it:

- references a missing row or column
- copies an original value that does not exactly match the cell
- targets a protected identifier
- targets a truncated cell
- uses a category other than `inconsistent`, `suspicious`, or `normalization`
- proposes an empty value, a multiline value, or an instruction-like value
- duplicates a cell that already has a deterministic edit

If two model suggestions hit one cell, the higher confidence one is kept. Accepting a second edit for a cell that already has an accepted edit is refused, and `applyAccepted` writes neither value if two accepted proposals disagree.

## Formula injection

On every download, a cell is prefixed with `'` when its first non-whitespace character is `=`, `+`, `-`, or `@`. The same guard applies to headers. This runs even when you accepted no edits, because it is an export safety control rather than a reviewed data change.

Excel treats the leading apostrophe as a text marker. It is in the file and usually hidden in the cell display. Legitimate negative numbers and plus-prefixed values become text. That is the tradeoff. Fullwidth lookalike characters are not rewritten.

The file is UTF-8 with a leading BOM so Excel on Windows can read accented characters. Column order is preserved. Papa Parse writes quotes where commas, quotes, or line breaks require them.

## Privacy

- Upload state lives in Vue memory. Refreshing the page clears the table. Firebase Anonymous Authentication may keep the same uid in browser storage, which is what the daily quota is counted against.
- The spreadsheet is not written to a database. `analyzeCsv` writes the quota counter. There is no Analytics hook.
- The UI says files stay in the browser on the first screen.
- Server logs in the function do not print cell values.

## Limits

- 1 MB file size
- 200 data rows
- 20 columns
- 2,000 characters per cell
- UTF-8 only. UTF-16 and invalid UTF-8 are rejected
- Comma delimiter
- Fully blank lines are skipped
- Headers must be unique, non-blank, and without surrounding spaces
- 10 `analyzeCsv` requests per anonymous uid per UTC day

## Decision log

Scoped out on purpose:

- Accounts, saved sessions, and multiplayer review
- App Check enforcement. Anonymous Authentication and the daily cap are in place; App Check is still a separate deploy step.
- Deleting duplicate rows or imputing missing values
- Manual cell editing
- Fuzzy duplicate clustering
- Excel workbooks and non-UTF-8 imports
- Collapsing internal whitespace
- Streaming files larger than the demo limits

What I would build next:

- App Check, plus billing and model-provider spend limits, before any public deploy
- A per-cell diff and an explicit “keep this duplicate, drop the others” action that still requires a choice
- An evaluation set of CSV fixtures for the prompt
- Pagination once the row limit moves past a few hundred

## Project layout

```text
shared/parseCsv.ts          decode, limits, Papa Parse
shared/deterministic.ts     rule findings
shared/suggestions.ts       AI schema checks, merge, apply
shared/analyze.ts           row selection, prompt, model pipeline
shared/exportCsv.ts         formula guard and CSV writer
functions/src/index.ts      OpenAI or Anthropic callable, anonymous-uid check
shared/analysisQuota.ts     Firestore transaction, 10 requests per UTC day
shared/secureAnalyze.ts     charge quota before the model call
src/composables/useClearRow.ts
src/components/             upload, chart, preview, review queue
```
