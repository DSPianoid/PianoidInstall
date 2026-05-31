"""dev-pyspawn-8b3a diagnostic: probe whether venv python.exe is a shim.

Reports:
- Own PID + executable + parent PID
- Whether running in a "shim child" pattern (parent is venv shim, we're system Python)

The launcher pattern we suspect: launcher spawns venv python.exe (shim), the shim
CreateProcesses C:\Python312\python.exe -u <script>, the shim becomes the parent.

Usage:
    PianoidCore/.venv/Scripts/python.exe docs/development/diagnostics/dev-pyspawn-8b3a-venv-shim-probe.py
"""
import os
import sys
import subprocess
import time

print(f"=== dev-pyspawn-8b3a venv shim probe ===")
print(f"PID: {os.getpid()}")
print(f"PPID: {os.getppid()}")
print(f"sys.executable: {sys.executable}")
print(f"sys.prefix: {sys.prefix}")
print(f"sys.base_prefix: {sys.base_prefix}")
print(f"sys._base_executable: {sys._base_executable}")
print(f"In venv per sys.prefix: {sys.prefix != sys.base_prefix}")
sys.stdout.flush()

# Now query our own process via WMI
my_pid = os.getpid()
r = subprocess.run(
    ['wmic', 'process', 'where', f'ProcessId={my_pid}', 'get', 'ExecutablePath,CommandLine', '/format:list'],
    capture_output=True, text=True
)
print(f"\n--- WMI view of MY process (PID={my_pid}) ---")
print(r.stdout)
sys.stdout.flush()

# Now query parent
ppid = os.getppid()
r2 = subprocess.run(
    ['wmic', 'process', 'where', f'ProcessId={ppid}', 'get', 'ExecutablePath,CommandLine,ParentProcessId', '/format:list'],
    capture_output=True, text=True
)
print(f"\n--- WMI view of PARENT process (PID={ppid}) ---")
print(r2.stdout)
sys.stdout.flush()

# Also check all python.exe processes
r3 = subprocess.run(
    ['wmic', 'process', 'where', "Name='python.exe'", 'get', 'ProcessId,ParentProcessId,ExecutablePath', '/format:list'],
    capture_output=True, text=True
)
print(f"\n--- All python.exe processes ---")
print(r3.stdout)
