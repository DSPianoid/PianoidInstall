# probe.py - runs INSIDE the launcher (sandbox or control). The harness prepends `TEST = ...` and `ARGS = ...`.
# Every probe reports only outcomes (READABLE / DENIED / ...), never the content of anything it touches.
# The last stdout line is one JSON object: {"test": ..., "results": {...}}.
import json, os, sys, time


def outcome(fn):
    try:
        r = fn()
        return r if isinstance(r, str) else "OK"
    except PermissionError:
        return "DENIED"
    except OSError as e:
        return "DENIED" if getattr(e, "winerror", None) == 5 else "ERR:%s:%s" % (type(e).__name__, getattr(e, "winerror", e.errno))
    except Exception as e:
        return "ERR:%s" % type(e).__name__


def t_files(a):
    res = {}
    for name, c in a["canaries"].items():
        def rd(p=c["file"]):
            with open(p, "rb") as f:
                f.read(16)
            return "READABLE"
        def ls(d=c["dir"]):
            os.listdir(d)
            return "LISTABLE"
        def wr(d=c["dir"]):
            with open(os.path.join(d, "probe-write-%s.txt" % a["tag"]), "wb") as f:
                f.write(b"probe")
            return "WRITTEN"
        def ap(p=c["file"]):
            with open(p, "ab") as f:
                f.write(b"X")
            return "WRITTEN"
        res[name] = {"read": outcome(rd), "list": outcome(ls), "write_new": outcome(wr), "append": outcome(ap)}
    def wrt():
        with open(os.path.join(a["runtime"], "probe-write-%s.txt" % a["tag"]), "wb") as f:
            f.write(b"probe")
        return "WRITTEN"
    res["runtime_dir"] = {"write_new": outcome(wrt)}
    return res


def t_net(a):
    import socket
    res = {}
    def tcp():
        s = socket.create_connection(("127.0.0.1", a["port"]), timeout=3)
        s.sendall(b"T")
        s.close()
        return "CONNECTED"
    def udp():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.sendto(b"U", ("127.0.0.1", a["port"]))
        s.close()
        return "SENT"
    res["tcp_connect"] = outcome(tcp)
    res["udp_sendto"] = outcome(udp)
    time.sleep(0.5)
    return res


def t_child(a):
    import subprocess
    py = sys.executable
    cmd = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe")
    dn = subprocess.DEVNULL
    attempts = [
        ("subprocess_python", lambda: subprocess.run([py, "-c", "pass"], stdin=dn, stdout=dn, stderr=dn, timeout=10).returncode),
        ("subprocess_cmd_exit", lambda: subprocess.run([cmd, "/c", "exit 0"], stdin=dn, stdout=dn, stderr=dn, timeout=10).returncode),
        ("os_spawnv_python", lambda: os.spawnv(os.P_WAIT, py, [py, "-c", "pass"])),
        ("loop_python_1", lambda: subprocess.run([py, "-c", "pass"], stdin=dn, stdout=dn, stderr=dn, timeout=10).returncode),
        ("loop_python_2", lambda: subprocess.run([py, "-c", "pass"], stdin=dn, stdout=dn, stderr=dn, timeout=10).returncode),
    ]  # exactly 5 attempts, no more
    res = {}
    for name, fn in attempts:
        def go(fn=fn):
            rc = fn()
            return "SPAWNED(rc=%s)" % rc
        res[name] = outcome(go)
    return res


def t_env(a):
    return {"SPIKE_CANARY_ENV": "PRESENT" if "SPIKE_CANARY_ENV" in os.environ else "ABSENT",
            "env_names": sorted(os.environ.keys())}


def t_reg(a):
    import winreg
    def rd():
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, a["regkey"]) as k:
            winreg.QueryValueEx(k, "canary")
        return "READABLE"
    def wr():
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, a["regkey"] + "\\probe") as k:
            winreg.SetValueEx(k, "probe", 0, winreg.REG_SZ, "probe")
        return "WRITTEN"
    return {"read": outcome(rd), "write_subkey": outcome(wr)}


def t_mem(a):
    blocks, got = [], 0
    step = 256
    try:
        while got < a["target_mb"]:
            blocks.append(bytearray(step << 20))  # zero-filled => committed
            got += step
        r = "ALLOCATED_ALL"
    except MemoryError:
        r = "MemoryError"
    del blocks
    return {"outcome": r, "allocated_mb": got, "target_mb": a["target_mb"]}


def t_cpu(a):
    t0 = time.time()
    x = 0
    while time.process_time() < a["burn_s"] and time.time() - t0 < a["max_wall_s"]:
        x += 1
    return {"outcome": "FINISHED", "process_time_s": round(time.process_time(), 2)}


def t_wall(a):
    time.sleep(a["sleep_s"])
    return {"outcome": "FINISHED", "slept_s": a["sleep_s"]}


def t_disk(a):
    chunk = b"\0" * (10 << 20)
    written = 0
    p = os.path.join("tmp", "fill.bin")
    try:
        with open(p, "wb") as f:
            while written < a["cap_mb"]:
                f.write(chunk)
                written += 10
        r = "WROTE_CAP"
    except OSError as e:
        r = "ERR:%s" % type(e).__name__
    return {"outcome": r, "written_mb": written}


def t_persist1(a):
    res = {}
    def w_container():
        with open(os.path.join(a["container_folder"], "persist-marker-%s.txt" % a["tag"]), "w") as f:
            f.write("marker")
        return "WRITTEN"
    def w_rundir():
        with open("persist-marker.txt", "w") as f:
            f.write("marker")
        return "WRITTEN"
    def w_storage():  # the container's own registry storage key (FullControl for the container)
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, a["storage_key"]) as k:
            winreg.SetValueEx(k, "persist-marker-%s" % a["tag"], 0, winreg.REG_SZ, "marker")
        return "WRITTEN"
    res["write_container_folder"] = outcome(w_container)
    res["write_container_registry"] = outcome(w_storage)
    res["write_own_rundir"] = outcome(w_rundir)
    res["LOCALAPPDATA_seen"] = os.environ.get("LOCALAPPDATA", "")
    return res


def t_persist2(a):
    def chk(p):
        def f():
            return "PRESENT" if os.path.exists(p) and open(p).read() == "marker" else "ABSENT"
        return f
    def reg():
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, a["storage_key"]) as k:
                return "PRESENT" if winreg.QueryValueEx(k, "persist-marker-%s" % a["tag"])[0] == "marker" else "ABSENT"
        except FileNotFoundError:
            return "ABSENT"
    return {"container_folder_marker": outcome(chk(os.path.join(a["container_folder"], "persist-marker-%s.txt" % a["tag"]))),
            "container_registry_marker": outcome(reg),
            "prev_run_dir_marker": outcome(chk(os.path.join(a["prev_run_dir"], "persist-marker.txt")))}


def t_positive(a):
    import hashlib
    import numpy as np, soundfile as sf
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    sr = 48000
    t = np.arange(sr) / sr
    y = 0.5 * np.sin(2 * np.pi * 440 * t) + 0.25 * np.sin(2 * np.pi * 1000 * t)
    sf.write(os.path.join("tmp", "tone.wav"), y.astype(np.float32), sr)
    z, sr2 = sf.read(os.path.join("tmp", "tone.wav"))
    spec = np.abs(np.fft.rfft(z * np.hanning(len(z))))
    freqs = np.fft.rfftfreq(len(z), 1 / sr2)
    lo, hi = freqs < 700, freqs >= 700  # one tone per band: 440 Hz and 1000 Hz
    peaks = [float(freqs[lo][np.argmax(spec[lo])]), float(freqs[hi][np.argmax(spec[hi])])]
    fig, ax = plt.subplots(figsize=(6, 3))
    ax.semilogy(freqs[:3000], spec[:3000])
    fig.savefig(os.path.join("out", "spectrum.png"), dpi=80)
    digest = hashlib.sha256(np.round(spec, 3).tobytes()).hexdigest()[:16]
    return {"peaks_hz": peaks, "spec_sha": digest, "png": os.path.exists(os.path.join("out", "spectrum.png"))}


res = globals()["t_" + TEST](ARGS)  # noqa: F821 (TEST / ARGS are prepended by the harness)
print(json.dumps({"test": TEST, "results": res}))  # noqa: F821
