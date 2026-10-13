# Security policy

Sunroost controls inverters, batteries and household devices, so please report security problems **privately**: use
GitHub's *Report a vulnerability* button on the Security tab of this repository (private vulnerability reporting). Do not
open a public issue.

Include what is affected, how to reproduce it, and the impact you expect. We aim to reply within 7 days and to fix
confirmed issues before details are published.

**Supported versions:** the latest release.

**Design notes for reporters:** the web UI is open on the local network unless a password is set (Configuration →
System). Remote access is off by default. The app runs as an unprivileged `sunroost` user with narrowly scoped
polkit/sudoers rules (see `deploy/install.sh`).
