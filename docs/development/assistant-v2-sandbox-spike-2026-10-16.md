# Assistant v2 P5a: analysis sandbox spike (2026-10-16)

Spike for proposal `assistant-v2-2026-10-16.md` §4.3 (code execution) and phase P5a. The question: can this
machine (Windows 10 Pro 19045, native, not WSL) run untrusted analysis Python in an **AppContainer + Job Object**,
**without admin**?

**Status: PARTIAL. The launcher works and Python runs in the sandbox. The escape suite has NOT been run: it is paused for a user decision.**
A proposed safe suite design is in [§6](#6-proposed-safe-escape-suite-for-user-approval).

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

## 5. Residual risks (not verified, because the escape suite was not run)

- **Disk fill:** a Job Object does not cap disk use. The run dir is writable without a limit while the run lasts.
  Options: NTFS quotas (need admin) or a post-run size check plus a short wall clock.
- **Cross-run persistence:** the AppContainer's own folder (`%LOCALAPPDATA%\Packages\<profile>\AC`) and its
  registry hive are shared by every run of the profile. Mitigations: wipe them after each run, or use one profile
  per run (creating a profile costs about 1.7 s).
- **Objects readable by `ALL APPLICATION PACKAGES`:** `C:\Windows`, `Program Files` and parts of `HKLM` are
  readable by design. Any user path or named pipe / RPC endpoint whose ACL grants ALL APPLICATION PACKAGES is
  reachable. Not enumerated.
- **DNS:** name resolution goes through the DNS Client service and may work without `internetClient`. That would
  be a possible exfiltration channel. Not tested.
- **Loopback and network:** blocked by design for an AppContainer without a loopback exemption. Not yet confirmed
  by a test on this machine.
- **Kernel attack surface:** win32k is still reachable. A `PROCESS_MITIGATION` win32k lockdown was not tried
  (matplotlib Agg should not need win32k).

## 6. Proposed SAFE escape suite (for user approval)

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

## 7. Recommendation (provisional)

AppContainer + Job Object **looks viable on native Windows 10 with no admin, ever**, given:

- the private runtime copy (finding 1);
- `DETACHED_PROCESS` (finding 2);
- `LOCALAPPDATA` set (finding 3).

It is not confirmed until the §6 suite passes. If the suite fails on DNS or on reachable objects in a way that
cannot be closed, the fallback is a container (Docker or WSL2), as in proposal §4.3 (C).

## 8. Cleanup state

- **Removed:** the AppContainer profile `pianoid.analysis.spike` (`DeleteAppContainerProfile` returned
  `0x00000000`). Its `Packages\...` folder and its `AppContainer\Mappings` registry key are gone. All ACEs for SID
  `S-1-15-2-1487943619-...-3178692513` were revoked on `runtime\`, `venv\` and `runs\r0\`; `icacls` shows none.
- **Kept, harmless:** `%USERPROFILE%\.pianoid-assistant\analysis\runtime` (311 MB),
  `...\analysis\venv` (283 MB) and `...\analysis\runs\r0` (97 kB, the hello-world run). Delete the whole
  `analysis\` folder to remove them.
- **Manual cleanup if a later run leaves a profile behind:**
  `PianoidSandbox.exe cleanup --profile <name> --revoke <dir> ...`
