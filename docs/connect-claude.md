# Connect Claude

Claude reaches the journal through the ThaiTastes MCP server. Do the "Deploy the AI layer" steps in the README first.

Your connector address is shown in the app under **Settings > AI assistants**. It looks like this:

```
https://<project-ref>.supabase.co/functions/v1/tt/mcp
```

## Claude app (web, desktop, phone)

The Claude app signs in with OAuth; there is no token to paste.

1. On claude.ai (web or desktop), open **Settings > Connectors > Add custom connector**.
2. Name: `ThaiTastes`. URL: your connector address.
3. If the dialog asks how to register, keep the default. If connecting then fails, choose **Register automatically**.
4. Click **Add**, then **Connect**. A browser tab opens on ThaiTastes.
5. Sign in if asked (email link or code), check that the screen says **Claude** and `claude.ai`, and press **Allow**.
6. You are back in Claude and the connector shows its 15 tools. It also works in the Claude phone app now.
7. Andra repeats steps 1 to 5 in her own Claude account. Each connection appears in Settings as "Claude (approved by greg)" or "(approved by andra)".

Notes:

- On a Team or Enterprise plan, an Owner adds the connector once and each member then presses **Connect**.
- The consent tab opens in the browser, not in the installed ThaiTastes app. On an iPhone the browser has its own
  sign-in, so the first time you sign in there with the code from the email.
- Access tokens last an hour and Claude renews them by itself. To cut Claude off, press **Revoke** on its row in
  Settings; to let it back in, press **Connect** in Claude again.
- If Claude reports that it cannot find the authorization server, tell me: that is the one part that could only be
  tested against the MCP client library, not against Claude itself (see "Known gaps" in `docs/PLAN.md`).

## Claude Code

Claude Code can send a fixed token, so OAuth is not needed.

1. In the app: **Settings > AI assistants > New connection**, name it (for example `Claude Code`), choose **Claude**,
   press **Create token** and copy the token. It is shown once.
2. Run:
   ```sh
   claude mcp add --transport http thaitastes https://<project-ref>.supabase.co/functions/v1/tt/mcp \
     --header "Authorization: Bearer tt_your_token"
   ```
3. `claude mcp list` should show `thaitastes` as connected.

Leaving out `--header` also works: Claude Code then opens the browser and uses the same sign-in as the Claude app.

## What Claude can do

| Reads | Writes |
| --- | --- |
| `get_context`, `search_entries`, `get_entry`, `list_dishes`, `list_places`, `get_stats`, `list_suggestions`, `get_latest_location` | `add_entry`, `update_entry`, `rate_entry`, `add_dish`, `add_place`, `toggle_fav`, `add_suggestion` |

- Every write is signed `claude`, names the connection, and is recorded in the audit log.
- Ratings are set only when you state them. Claude's own ideas go to the suggestions inbox on Home.
- Limits per connection: 60 calls a minute, 20 of them writes.

## Optional: a project instruction

The tool descriptions are enough on their own. If you keep a Claude project for the trip, this helps:

```
Use the ThaiTastes connector for anything about what we ate or where to eat in Thailand.
Call get_context first. Log an entry only when I say I ate something. Never guess a rating:
ask me, or leave it empty. Put your own recommendations in add_suggestion.
```

## Try it

Ask Claude: "What did we eat last in ThaiTastes?", then "Log that I just had khao soi, 60 baht, spice 4" with the
app open on your phone. The entry should appear within a few seconds, marked as added by Claude.
