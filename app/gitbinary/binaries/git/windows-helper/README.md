# Windows Git Remote Helper Files

This directory contains the git remote helpers + their DLL dependencies,
extracted from the official MinGit 2.55.0-64-bit.zip release. They are
embedded into the Go binary via `//go:embed` and released to
`${dataDir}/tools/git/` by `gitbinary.Init()` on first run.

## Why this is needed

The single-file `gk-git-2.55.0-windows-amd64.exe` is a git client that
does NOT include the remote helpers (git-remote-https/http). When the
user fetches a repo over HTTPS, git needs to spawn `git-remote-https.exe`
to handle the network. Without the helper, fetch fails with:

    git: 'remote-https' is not a git command
    fatal: remote helper 'https' aborted session

## Files

| File | Size | Purpose |
|------|------|---------|
| `git-remote-https.exe` | 2.5 MB | HTTPS remote helper (git invokes via PATH) |
| `git-remote-http.exe` | 47 KB | HTTP remote helper |
| `git-http-fetch.exe` | 2.5 MB | HTTP fetch backend (clone/pull internal) |
| `git-http-push.exe` | 2.5 MB | HTTP push backend |
| `lib*.dll` (18 files) | ~12 MB | libcurl/libssl/libssh2/libnghttp2 runtime deps |
| `zlib1.dll` | 128 KB | zlib compression |

Total: ~24 MB embedded + ~4.4 MB git.exe = ~28 MB.

## How Init() uses it

```go
//go:embed binaries/git/windows-helper/*.exe
//go:embed binaries/git/windows-helper/*.dll
var embeddedHelperWindows []byte  // (one var per file in practice)
```

At runtime, `gitbinary.Init()` copies these files into
`${dataDir}/tools/git/` alongside the main `gk-git-...exe`. Then a
`git.exe` shim is created (copy of gk-git), and `${dataDir}/tools/git`
is prepended to PATH + `GIT_EXEC_PATH` is set to the same dir. This
ensures:

1. `git remote-https` resolves via PATH lookup to our shim's directory
2. Git's child process finds `git-remote-https.exe` next to itself
3. libcurl DLLs are loadable (same directory as the helper)

## Source

Download URL: https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.1/MinGit-2.55.0-64-bit.zip

All files are unmodified copies from `mingw64/bin/` inside the zip.

## Update procedure

When bumping git version (e.g. 2.55.0 -> 2.56.0):

1. Download matching MinGit zip
2. Extract `mingw64/bin/` into a temp dir
3. `cp` the 22 files (4 exe + 18 lib*.dll) into this directory
4. Re-run `go build` to update the embedded blobs
5. Run `gitbinary` test suite (Windows runner) — see `runner_test.go`