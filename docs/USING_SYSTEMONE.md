# Using SystemOne (owner testing)

Updated 3 October 2026. One command starts everything; one glass bar is the
whole interface. V1 is **not ready**; this is development testing.

## Start

```sh
npm start
```

It checks Node 26 and confirms the Jev key (login Keychain item
`systemone-jev`) with TypeSafe without printing it. It closes leftover test
windows, ends an older SystemOne Dev if one is stuck, rebuilds when needed,
and opens SystemOne Dev with Jev on for this session.

First time after setting up signing:

1. If macOS asks for a password to let `codesign` use **SystemOne Local Dev**,
   enter your **Mac login password** and choose **Always Allow**.
2. In System Settings → Privacy & Security → Accessibility, add
   `.build/native-dev/SystemOne Dev.app` once. Browsing does **not** need
   this; only native-app actions do. The pinned certificate keeps the grant
   valid across rebuilds.

## Use the bar

**Hold Control-Option-Space, say what you want, release.** SystemOne works on
the app you were using (your own browser included) or opens what you ask for.
A quick tap just opens the bar; you can also type and press Return.

Try:
- `play the video` (on a YouTube page)
- `go to youtube and search for lofi beats and play the first result`
- `open Notes and type "buy milk"`
- `show me my Downloads in Finder`

Jev picks one step at a time from what is on screen. Each pick is either
auto-allowed or shown with **Allow / Allow all for this task / Stop**.
Auto-allow is on by default with `npm start`. Steps that look like send,
buy or delete still ask while ⚙ "Ask before send / buy / delete" is on.
Say "stop", press Esc or press Control-Option-Escape at any time. A new
request replaces the running one. Typed text comes only from your own words
(quotes, or what follows "search for" or "type").

Follow-ups within 10 minutes know what just happened ("now play the second
one", "go back"). Jev also knows your other open apps ("switch to Slack").
More examples: "copy the invoice number from the Acme email into a new note",
"message Priya on Slack saying running 5 minutes late" (no quotes needed),
"reply to Sam saying I will be late", "undo that". Typing into a document or
note appends; it never replaces what is already there.

When something goes wrong, run `npm run traces` and paste the output into
the chat. It shows each recent request's steps, as recorded locally on your
Mac.

SystemOne talks back: it says "Done", asks "Should I …?" when a step needs
your approval, and then listens about five seconds for "yes" or "no", with no
hotkey needed. Turn this off with ⚙ "Speak replies". Settings are remembered
between launches.

`privately go to <site> …` uses an isolated Chromium window instead of your
browser.

## What leaves the Mac

With Jev on, each step sends TypeSafe your request text, the front app's name,
window title and page URL, and the offered choices (visible labels of
buttons, links, fields and menus). It never
sends cookies, page bodies, handles or credentials. Speech recognition stays
on the Mac.

## Not yet

Native apps through Jev (Finder, any-app fields) come next; your existing
Chrome profile comes later. POST forms, logins, downloads, purchases and
messages are blocked. Thresholds are uncalibrated development values; every
step is confirmed by you.
