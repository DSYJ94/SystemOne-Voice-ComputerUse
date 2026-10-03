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

Press **Control-Option-Space**. Hold the mic and speak, or type, for example:

- `go to wikipedia.org and search for Alan Turing`
- `search github.com for playwright`
- `go to en.wikipedia.org`

A spoken request starts as soon as the transcript is final. A typed one
starts on Return. A private, isolated Chromium window opens on that site
only: the site and its subdomains, HTTPS, GET requests.

For each step Jev proposes one action under the bar, for example
`Step 2: Jev wants to press “Search”`:

- **Return**, or say **“yes”**: allow this one step. It runs, then is checked.
- **Esc**, say **“stop”**, or **Control-Option-Escape**: stop. The browser closes.

Jev chooses only from what the page shows: links on the site, the search
field (filled with your own words, nothing else), and search buttons. It
never invents URLs or text. When Jev thinks the goal is met it proposes
**finish**; your yes completes the task and the result stays open. A new
request closes it first. **⚙ Settings** has the Jev switch with its data
disclosure, voice and Accessibility status, and developer tools.

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
