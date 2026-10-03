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

**Hold Control-Option-Space and speak; release to run.** A quick tap just
opens the bar. You can also click the mic (click again to finish), or type
and press Return. The first time, allow Microphone and Speech Recognition.

Examples:

- `go to wikipedia and search for Alan Turing` (a bare name means
  wikipedia.org; other single words mean <name>.com)
- `search github for playwright`
- then, while that page is open: `change the page to German` or
  `now search for Enigma`. A follow-up continues in the same window. A new
  "go to …" closes it and starts fresh.

A private, isolated Chromium window opens on that site and its subdomains
only, using HTTPS and GET requests.

For each step Jev proposes one action under the bar, for example
`Step 2: Jev wants to press “Search”`, with three buttons:

- **Allow** (Return, or say **"yes"** with the hotkey): run this one step.
- **Allow all for this task**: Jev continues without asking; each step is
  still checked.
- **Stop** (Esc, say **"stop"**, or Control-Option-Escape): stop; the browser
  closes.

**⚙ Settings → Auto-allow steps** turns on auto mode for the whole session.
Jev chooses only from what the page offers: on-site links (including ones in
collapsed menus), the search field (filled only with your own words), search
buttons and ordinary buttons such as tabs or "show more". It never invents
URLs or text. When the goal looks done it proposes **finish**; the result
stays open for a follow-up.

## What leaves the Mac

With Jev on, each step sends TypeSafe your request text, the page title and
URL, and the offered choices (visible labels and on-site link URLs). It never
sends cookies, page bodies, handles or credentials. Speech recognition stays
on the Mac.

## Not yet

Native apps through Jev (Finder, any-app fields) come next; your existing
Chrome profile comes later. POST forms, logins, downloads, purchases and
messages are blocked. Thresholds are uncalibrated development values; every
step is confirmed by you.
