@echo off
rem BROWSER of `claude auth login` (service/auth.js): hand the sign-in URL to the pane instead of opening a tab.
rem %* keeps the quotes the CLI puts around the URL (an unquoted & would split the line); auth.js strips them.
>> "%PIANOID_AUTH_URL_FILE%" echo %*
