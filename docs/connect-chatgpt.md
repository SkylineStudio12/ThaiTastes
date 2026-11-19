# Connect ChatGPT

There are two routes. The Custom GPT route is the one to use; the MCP route is described for completeness and
could not be verified from here.

Do the "Deploy the AI layer" steps in the README first.

## Route 1: a Custom GPT with Actions (recommended)

1. In the ThaiTastes app: **Settings > AI assistants > New connection**. Name it `ChatGPT`, choose **ChatGPT**,
   press **Create token** and copy the token. It is shown once.
2. On chatgpt.com: **Explore GPTs > Create**, open the **Configure** tab.
3. Name: `ThaiTastes`. Instructions: paste the block below.
4. **Create new action > Import from URL** and enter `https://<your-pages-address>/openapi.json`
   (for example `https://skylinestudio12.github.io/ThaiTastes/openapi.json`). 15 actions appear.
5. **Authentication**: choose **API Key**, Auth Type **Bearer**, and paste the token.
6. **Save**, shared with **Only me**. (Sharing by link or publicly would require a privacy policy URL, and would
   give others your journal.)
7. Andra creates her own GPT the same way with her own token, or you invite her if your plan allows sharing in a
   workspace. With one token per person you can see who connected what in Settings.

Instructions to paste:

```
You help Greg and Andra with ThaiTastes, their food journal for a trip through Thailand.
Call get_context first: it gives today's date in Thailand, the current stage and the keys used by other actions.
Log an entry (add_entry) only when the user says they ate something. Find the dish and place ids with
list_dishes and list_places first; use dish_name or place_name only when nothing matches.
Never invent a rating. Call rate_entry only when the user states the rating and whose it is.
Your own ideas (a dish to try, a place nearby) go through add_suggestion, never straight into the journal.
If update_entry or rate_entry returns conflict: true, nothing was saved: merge your change into "current" and retry
with its updated_at.
Keep Thai script exactly as it is.
```

Notes:

- ChatGPT asks for confirmation before actions that write. Reading does not ask.
- Every write is signed `chatgpt`, names the connection, and is recorded in the audit log.
- Limits per connection: 60 calls a minute, 20 of them writes. One call may take up to 45 seconds and return up to
  about 100,000 characters; the list actions page their results (`limit`, `offset`).
- To cut ChatGPT off, press **Revoke** in Settings. **Rotate** gives a new token to paste into the GPT.
- `openapi.json` is rebuilt on every deploy of the app. After a change to the tools, re-import it in the GPT.

## Route 2: ChatGPT developer mode (MCP)

ChatGPT can also connect to the same MCP server Claude uses. Whether you can, and whether write tools are allowed,
depends on your plan; OpenAI's documentation could not be opened from the build environment, so treat these steps
as a starting point.

1. On chatgpt.com: **Settings > Apps & Connectors > Advanced settings**, turn on **Developer mode**.
2. **Create** a connector. Name: `ThaiTastes`. MCP server URL: `https://<project-ref>.supabase.co/functions/v1/tt/mcp`.
   Authentication: **OAuth**.
3. ChatGPT opens ThaiTastes in the browser. Sign in, check that the screen names ChatGPT and `chatgpt.com`, make sure
   "Entries it adds are signed as" says **ChatGPT**, and press **Allow**.
4. In a chat, enable the connector and ask "What did we eat last?".

If step 3 never opens, or ChatGPT reports an OAuth error, use Route 1 and tell me what it said.

## Try it

"What should we try next in the north?" should read `list_dishes`. "Log pad kra pao at the night market, 70 baht"
should ask to confirm, then show up in the open app within a few seconds, marked as added by ChatGPT.
