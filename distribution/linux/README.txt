MATRIX CODE FOR LINUX X64 — DEVELOPMENT PREVIEW

Target
  Linux x86_64 with glibc, initially modern Ubuntu and Debian releases.

Expected portable layout
  Matrix-Code-Linux-x64/
    matrix                 Matrix Code native executable
    matrix.sh              Portable lifecycle launcher
    omniroute/node         Bundled Node.js runtime
    omniroute/app/         Bundled official OmniRoute package
    templates/             Initial Matrix/OpenCode configuration
    LICENSE
    .matrix/               Created only on first real launch

Usage
  chmod +x matrix matrix.sh omniroute/node
  ./matrix.sh

The launcher keeps configuration, sessions, cache, OmniRoute data, and local
credentials under .matrix beside the executable. State directories are mode
0700 and credential files are mode 0600. Credentials are generated with the
bundled Node.js cryptographic random generator, inherited by child processes,
and never placed in command-line arguments or printed.

OmniRoute authentication remains enabled (REQUIRE_API_KEY=true). Existing
services on 127.0.0.1:20128 or 127.0.0.1:20260 are reused only when the local
credential successfully authenticates. Services started by matrix.sh are
tracked, ownership-checked through /proc, and terminated on normal exit,
SIGINT, SIGTERM, or SIGHUP. Pre-existing services are never terminated.

This source layout is not an announced Linux release. The build, package audit,
and native Linux smoke tests must pass before publishing a tar.gz artifact.
