# Setting up Google Calendar sync

Google Calendar sync is **optional**. Doseline is fully usable without it: medications, logging, history,
adherence, inventory and local alarms work offline and never depend on Google.

If you want your next dose to appear in Google Calendar (with pop-up reminders on your phone), create
your own free OAuth client. Doseline does not ship one: no credentials are hardcoded or committed.
Expect about five minutes.

Google renames console menus from time to time. If a label below doesn't match exactly, look for the
closest equivalent. Since 2025 the OAuth pages live under **Google Auth Platform** (older consoles call
it **APIs & Services → OAuth consent screen**).

## Before you start

- You need a regular Google account (the one whose calendar you want to use). You do **not** need a paid Google Cloud
  account, a billing account or a credit card. The Calendar API is free for personal use at this scale.
- If you've never used Google Cloud: the first time you open the console, Google asks you to choose your country and
  accept the **Google Cloud Terms of Service**. Accept them. If it offers a free trial, you can skip or dismiss it:
  nothing here needs billing.

---

## 1. Create a project

1. Open <https://console.cloud.google.com/> and sign in with the Google account whose calendar you want to use. Accept the terms if asked (see above).
2. Click the **project picker** in the top bar (it shows the current project name, or "Select a project").
3. Click **New project**.
4. **Project name:** `Doseline` (any name works). Leave *Location* as is.
5. Click **Create** and wait for the notification. Then make sure the new project is selected in the project picker.

## 2. Enable the Google Calendar API

1. Open the ☰ menu → **APIs & Services** → **Library**.
2. Search for **Google Calendar API** and click it.
3. Click **Enable**.

## 3. Configure the consent screen (External) and add yourself as a test user

1. Open the ☰ menu → **APIs & Services** → **OAuth consent screen**. You'll be taken to **Google Auth Platform**.
2. Click **Get started**.
3. **App information:** App name `Doseline`, User support email = your address. Click **Next**.
4. **Audience:** choose **External**. Click **Next**.
5. **Contact information:** enter your email address. Click **Next**.
6. Tick the box to agree to the Google API Services User Data Policy, then click **Continue** → **Create**.
7. In the left sidebar, click **Audience**.
8. Under **Test users**, click **+ Add users**, enter your own Google address, and click **Save**.
   (Test users matter while the app is in Testing. Adding yourself also avoids surprises if you later switch back.)
9. *(Optional)* In the left sidebar click **Data Access** → **Add or remove scopes** and add
   `https://www.googleapis.com/auth/calendar.app.created`. Doseline requests this scope at sign-in anyway.
   Listing it just documents it on the consent screen.

## 4. Create a "Desktop app" OAuth client

1. In the left sidebar of Google Auth Platform click **Clients** (older consoles: **APIs & Services → Credentials → + Create credentials → OAuth client ID**).
2. Click **+ Create client**.
3. **Application type:** **Desktop app**.
4. **Name:** `Doseline desktop`.
5. Click **Create**.
6. A dialog shows the **Client ID** (ends in `.apps.googleusercontent.com`) and **Client secret** (starts with `GOCSPX-`).
   **Copy both now.** Newer consoles only show the secret in full once. You can also click **Download JSON** and keep it somewhere private.

Desktop clients use a loopback redirect (`http://127.0.0.1:<random port>`), so you do **not** need to
register any redirect URI.

## 5. Set the publishing status to "In production"

1. In the left sidebar click **Audience**.
2. Under **Publishing status** (it says *Testing*), click **Publish app** → **Confirm**. The status now reads **In production**.

### Why this step matters

While an External app is in **Testing**, Google issues refresh tokens that **expire after 7 days** for
any scope other than basic profile info. Calendar scopes are affected. In Testing mode Doseline would silently
lose access every week and show **Reconnect Google** until you signed in again.

In **In production** the refresh token stays valid until you revoke it (or don't use it for 6 months).
Your app doesn't need Google verification for personal use. Because it's unverified, Google shows a
**"Google hasn't verified this app"** screen during sign-in. Click **Advanced → Go to Doseline (unsafe)**
to continue. It's your own app and your own client, so this is expected. Unverified apps are limited to
100 users, which is fine for a personal tool.

## 6. Connect Doseline

1. Open Doseline. On first run the welcome screen offers **Set up Google Calendar**. Later, it's in **Settings → Google Calendar**.
2. Paste the **Client ID** and **Client secret**, then click **Save and sign in with Google**.
3. Your default browser opens Google's sign-in page (Doseline never uses an embedded browser for sign-in).
   Choose your account. You'll see **"Google hasn't verified this app"**: click **Advanced**, then
   **Go to Doseline (unsafe)**. This is expected for your own private client (see step 5). On the permissions screen, make sure
   **"Make secondary Google calendars, and see, create, change, and delete events on them"** is checked.
4. The browser shows **Doseline is connected**. Close the tab and return to the app.
5. Doseline creates a calendar called **Medications** and adds one "next dose" event per medication.

### What Doseline can access

Doseline requests only:

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/calendar.app.created` | Create the dedicated **Medications** calendar and manage events **on calendars Doseline created**. It can't read or change your other calendars. |
| `openid`, `email` | Show which Google account is connected in Settings. |

The client secret and refresh token are stored on your PC, encrypted with Windows DPAPI via Electron
`safeStorage` (`%APPDATA%\Doseline\secure\`). They are never logged.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Settings shows **Reconnect Google** after about a week | The app is still in **Testing**. Do step 5, then click **Reconnect**. |
| "Access blocked: Doseline has not completed the Google verification process" | You're signing in with an account that isn't a test user while the app is in Testing. Add it (step 3.8) or publish (step 5). |
| "Calendar access was not granted" | On the permissions screen, tick the calendar checkbox, then sign in again. |
| `invalid_client` | The client ID or secret was mistyped, or the client was deleted. Re-enter them in **Settings → Google Calendar → Change client**. |
| You deleted the **Medications** calendar | Doseline recreates it automatically on the next sync. |
| Offline | Changes queue locally and retry with backoff. The title bar shows *Offline · N queued*. Alarms are unaffected. |

To revoke access at any time, open <https://myaccount.google.com/permissions> or use **Settings → Google Calendar → Disconnect**.
