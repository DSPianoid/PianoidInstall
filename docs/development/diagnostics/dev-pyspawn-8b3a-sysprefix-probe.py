"""dev-pyspawn-8b3a: probe sys.prefix when launching via venv shim like the launcher does.

The launcher's spawn: spawn(D:\\...\\venv\\Scripts\\python.exe, ['-u', backendServer.py],
                            cwd=D:\\...\\pianoid_middleware, env={..VIRTUAL_ENV..})

We mimic that and probe what sys.prefix resolves to in the CHILD interpreter.
"""
import os
import sys

print(f"PID: {os.getpid()}")
print(f"sys.executable: {sys.executable}")
print(f"sys.prefix: {sys.prefix}")
print(f"sys.base_prefix: {sys.base_prefix}")
print(f"In venv? {sys.prefix != sys.base_prefix}")
print(f"VIRTUAL_ENV env: {os.environ.get('VIRTUAL_ENV', '<unset>')}")
print()
print("Where does pianoidCuda import from?")
import pianoidCuda
print(f"  pianoidCuda.__file__: {pianoidCuda.__file__}")
import os
mt = os.path.getmtime(pianoidCuda.__file__)
sz = os.path.getsize(pianoidCuda.__file__)
print(f"  mtime: {mt}, size: {sz}")
print()
print("Has new methods?")
for m in ('getRawSoundRecordInt', 'getRawFilteredFloatRecord'):
    print(f"  {m}: {hasattr(pianoidCuda.Pianoid, m)}")
