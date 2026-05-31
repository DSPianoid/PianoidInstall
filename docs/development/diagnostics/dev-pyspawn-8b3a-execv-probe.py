"""Diagnostic probe for dev-pyspawn-8b3a.

Tests whether `os.execv` on Windows changes PID or creates a child process.
This determines whether the venv guard in backendServer.py acts as in-place
replacement (Linux semantics) or as spawn+exit (Windows semantics).

Usage:
    PianoidCore/.venv/Scripts/python.exe docs/development/diagnostics/dev-pyspawn-8b3a-execv-probe.py
"""
import os
import sys
import time

if len(sys.argv) == 1:
    # First invocation — capture parent PID, write to file, then execv to system Python
    parent_pid = os.getpid()
    parent_exe = sys.executable
    print(f"PARENT: PID={parent_pid}, exe={parent_exe}, parent_pid={os.getppid()}")
    sys.stdout.flush()

    # Write parent PID to a tmp file so we can compare from outside
    with open(r"D:\tmp\dev-pyspawn-execv-parent.txt", "w") as f:
        f.write(f"parent_pid={parent_pid}\nparent_exe={parent_exe}\n")

    # execv to SYSTEM Python with marker arg
    target = r"C:\Python312\python.exe"
    print(f"PARENT: about to execv to {target}")
    sys.stdout.flush()
    os.execv(target, [target, sys.argv[0], 'after'])
else:
    # Second invocation (post-execv)
    child_pid = os.getpid()
    child_exe = sys.executable
    parent_pid = os.getppid()
    print(f"CHILD: PID={child_pid}, exe={child_exe}, parent_pid={parent_pid}")
    sys.stdout.flush()
    # Sleep so the orchestrator can probe the live process
    with open(r"D:\tmp\dev-pyspawn-execv-child.txt", "w") as f:
        f.write(f"child_pid={child_pid}\nchild_exe={child_exe}\nparent_pid_of_child={parent_pid}\n")
    time.sleep(5)
    print("CHILD: exiting")
