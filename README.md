# Staffing Intake — Batch Request Console

A web app for submitting batches of agency and temporary staffing requests to Smartsheet. Users download a template with built-in dropdowns, fill it in, upload it, review a per-row validation report, and submit the rows that pass.

The Smartsheet token lives on the server, not in the browser. Users open the page and start working — there is nothing for them to configure.

---

## Architecture

```
Browser  ──►  Express server (Render)  ──►  Smartsheet API
              holds SMARTSHEET_TOKEN
```

The browser never sees the token. It calls two endpoints on its own origin, and the server attaches credentials before forwarding.

| Route | Purpose |
|---|---|
| `GET /api/config` | Sheet ID and whether an access code is required |
| `GET /api/columns` | Live column and picklist definitions |
| `POST /api/rows` | Writes up to 50 rows per request |
| `GET /api/health` | Health check for Render |

---

## The template

**Download blank template** generates a workbook with real Excel dropdowns on all 15 picklist columns. Requesters pick from a list instead of typing, which is where most bad data came from.

The option lists are pulled from the live sheet at the moment of download — not hardcoded. When someone adds a program number or a new department in Smartsheet, the next template picks it up with no code change. This also means a template downloaded months ago may be stale; encourage people to download a fresh one rather than reusing an old copy.

Behaviour by column type:

| Column type | On an unlisted value |
|---|---|
| Strict single-select (Staffing Category, Work Location, Union Group, Yes/No fields, Recruitment Phase, Duration, Office and Program Number) | Excel blocks the entry |
| Multi-select (ACHN Site, Work Days) | Excel warns and allows it — comma-separated values aren't in the list but are valid |
| Non-strict (Shift Time, Department) | Excel warns and allows it — Smartsheet will add it as a new option |

Other details baked into the generated file:

- Job Code and PID columns are formatted as text, so `0907` doesn't silently become `907`
- Header row is frozen, with autofilter enabled
- Required columns are shaded darker in the header
- Header cells carry comments explaining requirements and multi-value syntax
- Option lists live on a `veryHidden` worksheet so they can't be edited by accident

---

## Deploying to Render

1. Push this repository to GitHub.

2. In Render, create a **New Web Service** and connect the repository. The included `render.yaml` sets the runtime, build command, start command, and health check path automatically. To configure by hand:

   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/api/health`

3. Add environment variables under **Environment**:

   | Key | Required | Value |
   |---|---|---|
   | `SMARTSHEET_TOKEN` | Yes | Personal access token for the service account |
   | `SHEET_ID` | No | Defaults to `8431524360703876` |
   | `ACCESS_CODE` | No | If set, users enter this once per session |

4. Deploy. The service will not start without `SMARTSHEET_TOKEN` — it exits with a message rather than running in a broken state.

### About the free tier

Free services sleep after 15 minutes of inactivity, and the next request takes 30–50 seconds while the service wakes. The app shows a message explaining the wait rather than appearing to hang. The Starter plan removes the sleep.

---

## The service account

Create a dedicated Smartsheet user — for example `staffing-automation@yourdomain.org` — and share **only the destination sheet** with it at Editor level. Generate the token from that account.

Don't use a personal admin token. The server's token has whatever access its owner has, and it is used by everyone who opens the page.

Rotate it by generating a new token in Smartsheet, updating `SMARTSHEET_TOKEN` in Render, and letting the service redeploy.

### Attribution

Every row is written by the service account, so Smartsheet's cell history shows the service account rather than the person who submitted. The app compensates by asking for a name or email up front and logging it with each submission. If you need attribution inside the sheet itself, add a "Submitted By" column and map it in `SCHEMA`.

---

## Access control

By default anyone with the URL can submit. Two ways to tighten it:

**Access code.** Set `ACCESS_CODE` to any string. Users enter it once and it's held for the browser session. Compared with a timing-safe check and rate limited to 40 requests per minute per IP. Adequate for an internal tool with a URL that isn't published.

**SSO.** Put Cloudflare Access or a similar identity proxy in front of the Render URL. Stronger, and gives you real per-user logs.

---

## Server-side validation

Excel's dropdowns are a convenience, not a guarantee — validation can be bypassed by pasting, and older copies of the template may carry outdated lists. Every row is therefore re-checked on upload against the live schema:

- Required fields must be populated
- Strict picklists reject unknown values; non-strict ones accept them with a warning
- Email columns are format-checked
- Rate and hours must be numeric
- Leading zeros in Job Code and PID are preserved as text
- Multi-value columns are sent as proper `MULTI_PICKLIST` and `MULTI_CONTACT` objects rather than strings, which would fail

Conditional rules:

| Condition | Requires |
|---|---|
| Work Location is Ambulatory Care Health Network | ACHN Site |
| Is This a Union Role? = Yes | Union Group |
| Is This Position in the Recruitment Process? = Yes | Please Indicate the Recruitment Phase |

Rows that fail are held back; clean rows still go through. Every issue can be exported to CSV keyed to the original Excel row number, so a requester can correct their own file.

---

## Local development

```bash
npm install
cp .env.example .env      # add your token
node --env-file=.env server.js
```

Open `http://localhost:3000`.

---

## Configuration

`SCHEMA` in `public/index.html` defines the expected columns, their types, and which picklists are strict. `REQUIRED` lists columns that must be populated.

If a column is added to the sheet, add a matching entry to `SCHEMA`. Picklist *options* need no code change — they're read from the live sheet.

---

## Structure

```
server.js       Express server and Smartsheet proxy
public/
  index.html    Complete frontend
package.json
render.yaml     Render service definition
.env.example    Environment template
```

Express is the only server dependency. SheetJS (reading uploads) and ExcelJS (writing the validated template) load from CDN in the browser.
