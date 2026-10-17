# Assistant v2 P5a: analysis sandbox spike (2026-10-16)

Spike for proposal `assistant-v2-2026-10-16.md` §4.3 (code execution) and phase P5a. The question: can this
machine (Windows 10 Pro 19045, native, not WSL) run untrusted analysis Python in an **AppContainer + Job Object**,
**without admin**?

**Status: DONE (2026-10-17). The §6 SAFE suite was approved by the user and run twice, with identical results.
Every negative test was blocked in the sandbox, and each one was detected in control mode. Two isolation gaps
remain, both known in advance and both fixable in the launcher: cross-run persistence through the AppContainer
folder, and no disk quota. Results: [§9](#9-safe-suite-results-2026-10-17). Recommendation: [§7](#7-recommendation).**

## 1. Method

- Launcher: `tools/pianoid-assistant/sandbox-spike/launcher/PianoidSandbox.cs`. C#, built by `build.bat` with
  the .NET Framework 4 `csc.exe` that ships with Windows (no SDK, no admin). Verbs: `setup`, `run`, `cleanup`,
  `sid`.
- Interpreter: a private copy of the Python 3.12.3 runtime with numpy 2.5.4, scipy 1.18.1, matplotlib 3.11.2 and
  soundfile 0.14.0 (see finding 1).
- Workspace: `%USERPROFILE%\.pianoid-assistant\analysis\runs\<run_id>\`, with `out\` and `tmp\`.
- All measurements below are from real runs on this machine. The Pianoid stack, the GPU and the PianoidCore
  `.venv` were not touched.

## 2. Launcher design

| Layer | What it does |
|---|---|
| AppContainer | `CreateAppContainerProfile` with **zero capabilities**: no `internetClient`, no `privateNetworkClientServer`, no loopback exemption. The process is started with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`. |
| File access | The AppContainer SID gets **Modify on the run dir only**. That grant is added before the run and **revoked after** it, so one run cannot read another run's dir. It also gets **ReadAndExecute on the runtime dir**, set once at `setup`. Everything else is denied by the container's identity, not by a path filter. |
| Child processes | `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED`, plus a job `ActiveProcessLimit = 1`. |
| Job Object | Job and process memory limit (default 2 GB); job CPU-time limit (`--cpu-s`); one active process; `KILL_ON_JOB_CLOSE`; `DIE_ON_UNHANDLED_EXCEPTION`; `JOB_OBJECT_UILIMIT_ALL` (clipboard, handles, global atoms, desktop, system parameters, display settings, exit windows); `BELOW_NORMAL` priority, so the engine keeps the CPU. A completion port records limit events (`ACTIVE_PROCESS_LIMIT`, `JOB_MEMORY_LIMIT`, `END_OF_JOB_TIME`, ...) in the result. |
| Wall clock | The launcher waits `--wall-s`, then calls `TerminateJobObject`. |
| Handles | Only the stdout and stderr pipe handles are inherited (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`). stdin is null. |
| Environment | Built from an allow-list only. Nothing comes from the parent, so no `ANTHROPIC_*`, no `PIANOID_*` and no real `PATH`. `HOME` and `USERPROFILE` point to the run dir. `MPLBACKEND=Agg`, `CUDA_VISIBLE_DEVICES=-1`, BLAS limited to 2 threads. |
| Output | stdout capped at 20 kB and stderr at 8 kB; the pipes keep draining after the cap so the child never blocks. The `out\` listing is checked against ≤ 20 files, ≤ 5 MB each and ≤ 20 MB in total; files over a cap are flagged. |
| Result | One JSON object: `exit`, `wall_killed`, `job_msgs`, `job_total_processes`, `cpu_user_s`, `stdout`, `stderr`, `files`, and timings. |
| Command line | `python.exe -I -B -X utf8 code.py`, with the run dir as the working directory. |

## 3. Findings

1. **A standard venv cannot be the sandbox interpreter.**
   - On Windows, a venv's `python.exe` is a redirector that *spawns* the base interpreter. The one-process limit and
     the child policy block that second process.
   - The base install `C:\Python312` grants only `Users:RX`, with no `ALL APPLICATION PACKAGES` entry, so an
     AppContainer cannot load `python312.dll` from it (`0xC0000135`). With the child policy off, the venv
     redirector itself reports `No Python at C:\Python312\python.exe`.
   - Granting the container access to `C:\Python312` needs admin, because it is owned by Administrators.
   - **Workaround (no admin):** a self-contained copy of the runtime at
     `%USERPROFILE%\.pianoid-assistant\analysis\runtime`. It contains `DLLs`, `Lib`, `python.exe`, `python*.dll` and
     `vcruntime*.dll` from `C:\Python312`, with packages installed via `pip --target Lib\site-packages`. The user owns
     it, so the RX grant needs no elevation. Size: **311 MB**.
   - The ordinary venv at `...\analysis\venv` (**283 MB**) is used only as the pip host for building that runtime.
2. **The child-process policy breaks a console start.** With `CREATE_NO_WINDOW` the process dies with `0xC0000142`
   (DLL init failed), because Windows 10 starts a `conhost.exe` for every console process and the policy blocks it.
   **Fix:** `DETACHED_PROCESS`, so there is no console and no conhost. Python then works via the redirected std
   handles.
3. **An AppContainer `CreateProcess` with a custom environment fails with error 203** (`ERROR_ENVVAR_NOT_FOUND`)
   unless `LOCALAPPDATA` is present. Windows then rewrites `LOCALAPPDATA`, `TEMP` and `TMP` to
   `<LOCALAPPDATA>\Packages\<profile>\AC[\Temp]`. The launcher sets `LOCALAPPDATA` to `runs\<id>\tmp`, so the
   redirected temp also lands inside the run dir.
4. **Launcher bug, fixed 2026-10-17:** a trailing `//` comment on the environment line hid `MPLBACKEND=Agg` and
   `MPLCONFIGDIR`, so neither reached the sandbox. Both are now set, as §2 says. The §9 `env` test lists them.

Positive result: inside the AppContainer and the Job, `python -I` imported numpy, scipy.signal, matplotlib (Agg)
and soundfile. It exited with 0, `job_total_processes = 1`, and the environment was exactly the allow-list.

## 4. Overhead (measured)

| Step | Time |
|---|---|
| `setup` (create the profile + RX grant on the 311 MB runtime, propagated) | about 1.75 s, once |
| Per-run ACL grant on the run dir | about 6 ms |
| Launcher total before Python starts (job, attributes, `CreateProcess`, assign, resume) | about 20 ms |
| `import numpy, scipy.signal, matplotlib.pyplot, soundfile` in the sandbox (cold, first run) | 4.7 s (2.3 s CPU) |

The interpreter and library import cost dominates. Ways to cut it: a pre-built matplotlib font cache shipped
read-only next to the runtime, and lazy imports in the tool's prelude. Not measured in this spike.

### How the MCP tool would call the launcher

The `analysis.run_python` handler in the Node service never evaluates the code. It:

1. creates `runs\<run_id>\` and writes `code.py`;
2. copies the requested artefacts into `in\`;
3. runs, with `child_process.execFile` (no shell):
   `PianoidSandbox.exe run --profile pianoid.analysis --python <runtime>\python.exe --run-dir <runs\id> --script code.py --wall-s <timeout_s> --cpu-s <timeout_s> --mem-mb <memory_mb>`;
4. parses the one-line JSON from stdout;
5. turns `files` into artefacts;
6. returns `{exit, stdout, stderr, files, elapsed_s}`.

Setup is one call at install time, with no admin: `PianoidSandbox.exe setup --profile pianoid.analysis --grant-rx <runtime>`.

## 5. Residual risks

Status after the §9 suite (2026-10-17):

| Risk | Status |
|---|---|
| **Cross-run persistence** | **Confirmed.** Run 1 wrote a marker into the container's own folder (`%LOCALAPPDATA%\Packages\<profile>\AC`). Run 2 read it. Every run of a profile shares that folder (and the container's registry hive). The previous run's *run dir* was not readable, because its ACE is revoked after each run. Fix: wipe `AC\` after every run, or use one profile per run (about 1.7 s each). |
| **Disk fill** | **Confirmed, no cap.** The sandbox wrote 500 MB (the test's own cap) into its run dir in 0.28 s. At that rate a 60 s run could fill C: (30 GB free). Fix: a launcher watchdog that polls the run-dir size and calls `TerminateJobObject` at a cap, plus the post-run check. NTFS quotas need admin. |
| **CPU-time limit overshoot** | **Measured.** With `--cpu-s 3`, `END_OF_JOB_TIME` fired at 6.6 s and at 7.6 s of user CPU (two runs). The limit works but is loose. The cause was not measured. Treat `--wall-s` as the hard bound. |
| UDP send reports success | Inside the sandbox `sendto` succeeds, but the listener receives nothing. The packet is dropped below the socket API. Harmless. |
| **Objects readable by `ALL APPLICATION PACKAGES`** | Not tested. `C:\Windows`, `Program Files` and parts of `HKLM` are readable by design. Any user path, named pipe or RPC endpoint whose ACL grants ALL APPLICATION PACKAGES is reachable. Not enumerated (out of the approved scope). |
| **DNS** | Not tested (out of the approved scope). Name resolution goes through the DNS Client service and may work without `internetClient`, which would be an exfiltration channel. |
| **Kernel attack surface** | Not tested. win32k is still reachable. A `PROCESS_MITIGATION` win32k lockdown was not tried. |
| Clipboard | Skipped. `JOB_OBJECT_UILIMIT_ALL` is set, but it was not exercised. |

## 6. SAFE escape suite (design; approved by the user 2026-10-17)

These rules keep every test away from real secrets, real processes and the user's desktop:

- **Canary files only.** Before the run, the harness plants dummy files with random content, for example
  `canary-<rand>.txt`, in sibling dirs of the workspace: `analysis\canary-sibling\`, `analysis\` itself,
  `%USERPROFILE%\.pianoid-assistant\canary\` and a temp dir under the repo worktree. The sandboxed code tries to
  read, list and write them. **No real credential paths** (`~/.claude`, `claude-home`) and no real repo files are
  touched. A canary read reports only `READABLE` or `DENIED`. The harness checks the canary hashes and that no new
  files appeared outside the run dir.
- **Write-outside test:** the code tries to create a file next to the canaries and in the runtime dir. Pass means
  every attempt is denied and the harness finds nothing new.
- **Network: local only.** The harness starts its own TCP and UDP listener on a spare `127.0.0.1` port. The
  sandbox tries to connect (TCP) and send one byte (UDP). Pass means the listener received nothing. There are no
  internet targets and no DNS lookups. (DNS is left as a documented open item, or tested later against a local
  resolver only if the user wants that.)
- **Child processes:** only an attempt to spawn `python.exe -c pass` (the runtime itself) via `subprocess` and
  `os.spawnv`, plus a bounded spawn loop of 5 attempts. There is no fork bomb, and no enumeration or opening of
  real processes. Pass means every spawn fails and `job_total_processes == 1`.
- **Resource limits:** allocate in 256 MB steps up to 4 GB (expect `MemoryError` / `JOB_MEMORY_LIMIT`). Run a busy
  loop past `--cpu-s` (expect `END_OF_JOB_TIME`). Run a sleep loop past `--wall-s` (expect `wall_killed`).
- **Environment:** the harness sets a dummy `SPIKE_CANARY_ENV=<rand>` in the launcher's environment. The sandbox
  checks that it is absent. No other environment variables are read.
- **Registry:** read only a dummy key the harness creates (`HKCU\Software\PianoidSandboxCanary`). Expect denied.
- **Clipboard / UI:** either skipped, or limited to content the test sets itself (the harness puts a random token
  on the clipboard; the sandbox tries to read it and reports only match / no match). No window enumeration, no
  window titles, no screen capture, no input injection.
- **Positive test:** generate a WAV in the run dir, compute a numpy/scipy FFT, write a PNG to `out\`, and compare
  with the same computation run outside the sandbox.

Pass criterion: 100 % of the negative tests are denied and the positive test matches. Run each negative test
first in a **control** mode (`--no-appcontainer`, same Job) to prove the test can detect access, then in the
sandbox.

## 7. Recommendation

**GO: use AppContainer + Job Object for P5a, on native Windows 10, with no admin.** The §9 suite blocked every
file, registry, network, environment and child-process escape, and the memory, CPU and wall limits all fired.
The positive test gave the same result inside and outside the sandbox. A Docker or WSL2 fallback is not needed.

Before production, the launcher needs three changes:

1. **Wipe the container folder** (`Packages\<profile>\AC`) after every run, and check that it is empty before
   the next run. This closes the confirmed cross-run channel. A profile per run is the stricter alternative.
2. **Disk watchdog:** poll the run-dir size (for example every 250 ms) and terminate the job at a cap (for
   example 200 MB). Keep the post-run size check.
3. **Wall clock is the hard bound:** keep `--wall-s` short and set `--cpu-s` to at most half of it, because the
   job CPU limit overshoots.

Still requirements for P5a:

- the private runtime copy (finding 1);
- `DETACHED_PROCESS` (finding 2);
- `LOCALAPPDATA` set (finding 3).

Optional hardening for later: a win32k lockdown, and a DNS test against a local resolver only (needs a separate
user approval).

## 8. Cleanup state

- **Removed:** the AppContainer profile `pianoid.analysis.spike` (`DeleteAppContainerProfile` returned
  `0x00000000`). Its `Packages\...` folder and its `AppContainer\Mappings` registry key are gone. All ACEs for SID
  `S-1-15-2-1487943619-...-3178692513` were revoked on `runtime\`, `venv\` and `runs\r0\`; `icacls` shows none.
- **Kept, harmless:** `%USERPROFILE%\.pianoid-assistant\analysis\runtime` (311 MB),
  `...\analysis\venv` (283 MB) and `...\analysis\runs\r0` (97 kB, the hello-world run). Delete the whole
  `analysis\` folder to remove them.
- **Manual cleanup if a later run leaves a profile behind:**
  `PianoidSandbox.exe cleanup --profile <name> --revoke <dir> ...`

After the §9 suite (2026-10-17), checked from outside the harness:

- **Removed:** profile `pianoid.analysis.suite` (SID `S-1-15-2-3572169833-...-1416914356`), `delete_hr = 0x00000000`.
  Its `AppContainer\Mappings\<SID>` key and its `Packages\pianoid.analysis.suite` folder (with the persistence
  marker) are gone.
- **ACEs:** `icacls` finds no entry for that SID on `runtime\`, `runtime\python312.dll`,
  `runtime\Lib\site-packages` or `runs\`.
- **Canaries:** every canary dir and file is gone (`analysis\canary-sibling-*`, the file in `analysis\`,
  `.pianoid-assistant\canary-*`, `%TEMP%\pianoid-sandbox-canary-*`, the worktree `.sandbox-canary\`).
  `HKCU\Software\PianoidSandboxCanary` is gone. `SPIKE_CANARY_ENV` was only ever set in the harness process; it is
  not in `HKCU\Environment`.
- **Run dirs:** all `runs\suite-*` dirs (including the 500 MB fill file) are deleted. `runs\` holds only `r0`.

## 9. SAFE suite results (2026-10-17)

Harness: `tools/pianoid-assistant/sandbox-spike/suite/run_safe_suite.py` (runs outside the sandbox) and `probe.py`
(runs inside). The harness plants its own canaries, starts its own `127.0.0.1` TCP+UDP listener on a spare port,
runs each negative test first in **control** mode and then in the **sandbox**, and checks the results from outside
(canary SHA-256 hashes, new-file listings, listener counters, registry). Profile `pianoid.analysis.suite`. The
suite ran **twice** (tags `7976ca03` and `1caabf8c`) with identical outcomes; the timings below are from the second
run.

Control flags: `--no-appcontainer` (same job, same env allow-list). For `child`, `mem` and `cpu` the control also
drops the job and the child policy (`--no-job --no-child-policy`), because the job would otherwise block the
action itself.

| Test | What the probe tries | Control | Sandbox | Checked from outside | Result |
|---|---|---|---|---|---|
| files | read, list, create a file in, and append to a canary in 5 dirs: `analysis\canary-sibling-*`, `analysis\`, `.pianoid-assistant\canary-*`, `%TEMP%\pianoid-sandbox-canary-*`, `D:\...\worktree\.sandbox-canary` | all 5: READABLE, LISTABLE, WRITTEN, WRITTEN | all 5: DENIED ×4 | control: 5 canaries modified, 5 new files. Sandbox: hashes unchanged, no new files | **CONTAINED** |
| write to runtime | create a file in `analysis\runtime\` | WRITTEN | DENIED | sandbox: no new file | **CONTAINED** |
| net | TCP connect + UDP sendto to the harness listener on 127.0.0.1 | CONNECTED, SENT | TCP timeout (3 s); UDP `sendto` returns OK | control: 1 TCP conn, 1 byte, 1 UDP packet. Sandbox: 0 / 0 / 0 | **CONTAINED** |
| child | 5 attempts: `subprocess` python `-c pass`, `cmd /c exit 0`, `os.spawnv` python, 2 more python | 5 × SPAWNED (rc 0) | 5 × DENIED | sandbox `job_total_processes = 1` | **CONTAINED** |
| env | is `SPIKE_CANARY_ENV` (set in the launcher's env) visible? | PRESENT (`--env-copy`) | ABSENT | sandbox env = the 16-name allow-list only | **CONTAINED** |
| registry | read `HKCU\Software\PianoidSandboxCanary`, create a subkey | READABLE, WRITTEN | DENIED, DENIED | sandbox: subkey not created | **CONTAINED** |
| memory | allocate in 256 MB steps (control target 2304 MB, sandbox 3072 MB; limit 2048 MB) | 2304 MB allocated | `MemoryError` at 1792 MB; `PROCESS_MEMORY_LIMIT` | — | **ENFORCED** |
| CPU time | busy loop (control 6 s; sandbox 15 s with `--cpu-s 3`) | ran 6.0 s CPU | killed, `END_OF_JOB_TIME`, exit `0xC0000044` at 6.6 s / 7.6 s user CPU | — | **ENFORCED, loose** (see §5) |
| wall clock | `sleep(8)` (control `--wall-s 20`, sandbox `--wall-s 3`) | finished, 8.1 s | `wall_killed`, exit `0xC0DE0001` at 3.1 s | — | **ENFORCED** |
| disk fill (inside) | write 10 MB chunks to `tmp\` up to a 500 MB test cap | not run | wrote all 500 MB in 0.28 s | run dir = 500 MB | **NOT CAPPED** (expected; §5) |
| cross-run | run 1 writes a marker to the container folder and to its run dir; run 2 looks for both | not run | container-folder marker PRESENT; previous run dir ABSENT (no access) | — | **LEAKS via `AC\` folder** (§5) |
| positive | 48 kHz WAV (440 + 1000 Hz) → soundfile → numpy FFT → matplotlib PNG in `out\` | peaks 440, 1000 Hz; hash `f3a12090fd2964b3`; PNG | same peaks, same hash, PNG | — | **MATCH** |
| clipboard / UI | — | skipped | skipped | — | not tested |

**Failed containment:** none of the escape tests (files, runtime write, network, child processes, env,
registry). Two isolation gaps, both listed in §5 before the run: the shared `AC\` folder (cross-run channel) and
no disk cap. The CPU limit works but overshoots by about 2×.
