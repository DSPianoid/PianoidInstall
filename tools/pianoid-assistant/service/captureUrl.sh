#!/bin/sh
# BROWSER of `claude auth login` (service/auth.js): hand the sign-in URL to the pane instead of opening a tab.
printf '%s\n' "$1" >> "$PIANOID_AUTH_URL_FILE"
