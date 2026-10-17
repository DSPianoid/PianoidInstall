# run_safe_suite.py - the §6 SAFE escape suite of the analysis sandbox (spike doc §6 / §9; re-run against the
# production launcher by dev-11f8, P5: the disk cap and the container wipe (folder + registry storage) now PASS).
#
# Runs OUTSIDE the sandbox. It plants its own canaries (files, one HKCU key, one env var), starts its own
# 127.0.0.1 TCP+UDP listener, runs every negative test first in CONTROL mode (no AppContainer; some tests also
# no job) to prove the probe detects access, then in the SANDBOX, and checks the results from outside.
# Nothing real is targeted: no credential paths, no repo files, no real processes, no internet, no DNS.
#
#   python -I run_safe_suite.py --launcher PianoidSandbox.exe --runtime <analysis\runtime> --out results.json
#                               [--extra-canary-dir DIR]
# Cleanup (profile, ACEs, canaries, registry key, run dirs) runs in `finally`.
import argparse, hashlib, json, os, secrets, shutil, socket, subprocess, sys, threading, time, winreg

HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = "pianoid.analysis.suite"
REGKEY = r"Software\PianoidSandboxCanary"
PIANOID_PORTS = {3000, 3001, 5000, 5001, 8001}


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def listing(d):
    return set(os.listdir(d)) if os.path.isdir(d) else set()


class Listener:
    """TCP + UDP listener on 127.0.0.1, same spare port; counts what arrives."""
    def __init__(self):
        while True:
            self.tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.tcp.bind(("127.0.0.1", 0))
            self.port = self.tcp.getsockname()[1]
            if self.port in PIANOID_PORTS:
                self.tcp.close(); continue
            self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                self.udp.bind(("127.0.0.1", self.port)); break
            except OSError:
                self.tcp.close(); self.udp.close()
        self.tcp.listen(4); self.tcp.settimeout(0.2); self.udp.settimeout(0.2)
        self.tcp_conns = self.tcp_bytes = self.udp_pkts = 0
        self.stop = False
        threading.Thread(target=self._tcp, daemon=True).start()
        threading.Thread(target=self._udp, daemon=True).start()

    def _tcp(self):
        while not self.stop:
            try:
                c, _ = self.tcp.accept()
            except OSError:
                continue
            self.tcp_conns += 1
            c.settimeout(1)
            try:
                self.tcp_bytes += len(c.recv(16))
            except OSError:
                pass
            c.close()

    def _udp(self):
        while not self.stop:
            try:
                self.udp.recvfrom(16); self.udp_pkts += 1
            except OSError:
                continue

    def reset(self):
        self.tcp_conns = self.tcp_bytes = self.udp_pkts = 0

    def close(self):
        self.stop = True; time.sleep(0.3); self.tcp.close(); self.udp.close()


STORAGE = "\\".join(["Software", "Classes", "Local Settings", "Software", "Microsoft", "Windows", "CurrentVersion",
                      "AppContainer", "Storage", PROFILE])


def storage_entries():
    """Values + subkeys of the container's registry storage, minus its empty system subkey Children."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, STORAGE) as k:
            n_sub, n_val, _ = winreg.QueryInfoKey(k)
            names = [winreg.EnumKey(k, i) for i in range(n_sub)]
        return n_val + len([n for n in names if n != "Children"])
    except FileNotFoundError:
        return 0


def verdicts(t):
    """PASS / FAIL per test from the recorded control + sandbox outcomes (control must detect, sandbox must block)."""
    v = {}
    def sb(name): return t[name]["sandbox"]
    def ct(name): return t[name].get("control")
    f = sb("files")
    canaries_blocked = all(r == {"read": "DENIED", "list": "DENIED", "write_new": "DENIED", "append": "DENIED"}
                           for k, r in f["probe"].items() if k != "runtime_dir")
    v["files"] = (canaries_blocked and not f["after"]["canaries_modified"] and not f["after"]["new_files"]
                  and bool(ct("files")["after"]["canaries_modified"]))
    v["write_runtime"] = (f["probe"]["runtime_dir"]["write_new"] == "DENIED" and not f["after"]["runtime_new_files"]
                          and ct("files")["probe"]["runtime_dir"]["write_new"] == "WRITTEN")
    v["net"] = sb("net")["listener"] == {"tcp_conns": 0, "tcp_bytes": 0, "udp_pkts": 0} and ct("net")["listener"]["tcp_conns"] > 0
    v["child"] = (not any(r.startswith("SPAWNED") for r in sb("child")["probe"].values())
                  and sb("child")["job_total_processes"] == 1
                  and all(r.startswith("SPAWNED") for r in ct("child")["probe"].values()))
    v["env"] = sb("env")["probe"]["SPIKE_CANARY_ENV"] == "ABSENT" and ct("env")["probe"]["SPIKE_CANARY_ENV"] == "PRESENT"
    v["registry"] = (sb("reg")["probe"] == {"read": "DENIED", "write_subkey": "DENIED"} and not sb("reg")["subkey_created"]
                     and ct("reg")["probe"]["read"] == "READABLE")
    v["memory"] = "memory" in sb("mem")["limits_hit"] and ct("mem")["probe"]["outcome"] == "ALLOCATED_ALL"
    v["cpu"] = "cpu" in sb("cpu")["limits_hit"] and not sb("cpu")["wall_killed"]
    v["wall"] = "wall" in sb("wall")["limits_hit"] and ct("wall")["probe"]["outcome"] == "FINISHED"
    v["disk"] = "disk" in sb("disk")["limits_hit"] and sb("disk")["rundir_mb"] < 300
    p1, p2 = sb("persist1"), sb("persist2")["probe"]
    v["cross_run"] = (p1["probe"]["write_container_folder"] == "WRITTEN" and p1["probe"]["write_container_registry"] == "WRITTEN"
                      and p1["outside_after"] == {"ac_entries": 0, "storage_entries": 0}
                      and p2 == {"container_folder_marker": "ABSENT", "container_registry_marker": "ABSENT",
                                 "prev_run_dir_marker": "ABSENT"})
    pc, ps = ct("positive")["probe"], sb("positive")["probe"]
    v["positive"] = pc == ps and ps["png"] and ps["peaks_hz"] == [440.0, 1000.0]
    return {k: "PASS" if ok else "FAIL" for k, ok in v.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--launcher", required=True)
    ap.add_argument("--runtime", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--extra-canary-dir", action="append", default=[])
    a = ap.parse_args()
    launcher = os.path.abspath(a.launcher)
    runtime = os.path.abspath(a.runtime)
    python = os.path.join(runtime, "python.exe")
    home = os.path.expanduser("~")
    analysis = os.path.join(home, ".pianoid-assistant", "analysis")
    runs = os.path.join(analysis, "runs")
    tag = secrets.token_hex(4)
    probe_src = open(os.path.join(HERE, "probe.py"), encoding="utf-8").read()

    canary_dirs = {
        "analysis_canary_sibling": os.path.join(analysis, "canary-sibling-" + tag),
        "analysis_root": analysis,  # canary FILE planted directly in analysis\ (dir itself is pre-existing)
        "pianoid_assistant_canary": os.path.join(home, ".pianoid-assistant", "canary-" + tag),
        "user_temp_canary": os.path.join(os.environ["TEMP"], "pianoid-sandbox-canary-" + tag),
    }
    for i, d in enumerate(a.extra_canary_dir):
        canary_dirs["extra_%d" % i] = os.path.abspath(d)
    created_dirs = [d for k, d in canary_dirs.items() if k != "analysis_root"]
    canaries, run_dirs, results = {}, [], {"tag": tag, "profile": PROFILE, "tests": {}}
    listener = None
    os.environ["SPIKE_CANARY_ENV"] = secrets.token_hex(8)  # this process + the launcher only; never persisted
    reg_created = False
    sid = None
    try:
        # --- plant canaries ---
        for k, d in canary_dirs.items():
            os.makedirs(d, exist_ok=True)
            f = os.path.join(d, "canary-%s.txt" % tag)
            with open(f, "w") as fh:
                fh.write(secrets.token_hex(32))
            canaries[k] = {"dir": d, "file": f}
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, REGKEY) as k:
            winreg.SetValueEx(k, "canary", 0, winreg.REG_SZ, secrets.token_hex(8))
        reg_created = True
        listener = Listener()
        results["listener_port"] = listener.port

        # --- profile ---
        setup = json.loads(subprocess.run([launcher, "setup", "--profile", PROFILE, "--grant-rx", runtime],
                                          capture_output=True, text=True, check=True).stdout)
        sid, container_folder = setup["sid"], setup["container_folder"]
        results["setup"] = setup

        def baseline():
            return ({k: sha(c["file"]) for k, c in canaries.items()},
                    {k: listing(c["dir"]) for k, c in canaries.items()}, listing(runtime))

        def after_check(base):
            hashes, lists, rt = base
            changed = [k for k, c in canaries.items() if sha(c["file"]) != hashes[k]]
            new = {}
            for k, c in canaries.items():
                extra = listing(c["dir"]) - lists[k]
                if extra:
                    new[k] = sorted(extra)
                    for n in extra:  # probe-created only (names are probe-write-*); remove, restore canary
                        p = os.path.join(c["dir"], n)
                        if n.startswith("probe-write-"):
                            os.remove(p)
            rt_new = sorted(listing(runtime) - rt)
            for n in rt_new:
                if n.startswith("probe-write-"):
                    os.remove(os.path.join(runtime, n))
            for k in changed:  # re-plant a fresh canary after a control-mode append
                with open(canaries[k]["file"], "w") as fh:
                    fh.write(secrets.token_hex(32))
            return {"canaries_modified": changed, "new_files": new, "runtime_new_files": rt_new}

        def run(test, mode, args, flags, wall=60, cpu=None, mem=2048, disk=200):
            rd = os.path.join(runs, "suite-%s-%s-%s" % (tag, test, mode))
            os.makedirs(rd, exist_ok=True); run_dirs.append(rd)
            with open(os.path.join(rd, "code.py"), "w", encoding="utf-8") as f:
                f.write("TEST = %r\nARGS = %s\n" % (test, json.dumps(args)) + probe_src)
            cmd = [launcher, "run", "--profile", PROFILE, "--python", python, "--run-dir", rd, "--script", "code.py",
                   "--wall-s", str(wall), "--cpu-s", str(cpu or wall), "--mem-mb", str(mem), "--disk-mb", str(disk)] + flags
            base = baseline(); listener.reset()
            t0 = time.time()
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=wall + 60)
            j = json.loads(p.stdout.strip().splitlines()[-1])
            probe = None
            for line in reversed(j.get("stdout", "").strip().splitlines()):
                try:
                    probe = json.loads(line)["results"]; break
                except Exception:
                    continue
            rec = {"mode": mode, "flags": flags, "exit_hex": j.get("exit_hex"), "wall_killed": j.get("wall_killed"),
                   "limits_hit": j.get("limits_hit"), "limits": j.get("limits"), "disk": j.get("disk"),
                   "ac_entries_before": j.get("ac_entries_before"), "ac_entries_after": j.get("ac_entries_after"),
                   "job_msgs": j.get("job_msgs"), "job_total_processes": j.get("job_total_processes"),
                   "cpu_user_s": j.get("cpu_user_s"), "probe": probe, "stderr_tail": j.get("stderr", "")[-600:],
                   "listener": {"tcp_conns": listener.tcp_conns, "tcp_bytes": listener.tcp_bytes, "udp_pkts": listener.udp_pkts},
                   "after": after_check(base), "elapsed_s": round(time.time() - t0, 2),
                   "rundir_mb": round(sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(rd) for f in fs) / 2**20, 1)}
            results["tests"].setdefault(test, {})[mode] = rec
            print("%-9s %-8s exit=%s killed=%s msgs=%s procs=%s probe=%s" % (test, mode, rec["exit_hex"], rec["wall_killed"],
                  rec["job_msgs"], rec["job_total_processes"], json.dumps(probe)[:300]), flush=True)
            return rec

        CTRL = ["--no-appcontainer"]
        CTRL_NOJOB = ["--no-appcontainer", "--no-job", "--no-child-policy"]
        fa = {"canaries": canaries, "runtime": runtime, "tag": tag}
        run("files", "control", fa, CTRL); run("files", "sandbox", fa, [])
        na = {"port": listener.port}
        run("net", "control", na, CTRL); run("net", "sandbox", na, [])
        run("child", "control", {}, CTRL_NOJOB); run("child", "sandbox", {}, [])
        run("env", "control", {}, CTRL + ["--env-copy", "SPIKE_CANARY_ENV"]); run("env", "sandbox", {}, [])
        ra = {"regkey": REGKEY}
        run("reg", "control", ra, CTRL)
        try:  # the control write creates REGKEY\probe; remove it before the sandbox run
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, REGKEY + r"\probe")
        except OSError:
            pass
        run("reg", "sandbox", ra, [])
        try:
            winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGKEY + r"\probe").Close()
            results["tests"]["reg"]["sandbox"]["subkey_created"] = True
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, REGKEY + r"\probe")
        except OSError:
            results["tests"]["reg"]["sandbox"]["subkey_created"] = False
        run("mem", "control", {"target_mb": 2304}, CTRL_NOJOB)
        run("mem", "sandbox", {"target_mb": 3072}, [], mem=2048)
        run("cpu", "control", {"burn_s": 6, "max_wall_s": 15}, CTRL_NOJOB, wall=30)
        run("cpu", "sandbox", {"burn_s": 15, "max_wall_s": 20}, [], wall=30, cpu=3)
        run("wall", "control", {"sleep_s": 8}, CTRL, wall=20)
        run("wall", "sandbox", {"sleep_s": 8}, [], wall=3)
        run("disk", "sandbox", {"cap_mb": 500}, [], wall=60, disk=200)
        pa = {"container_folder": container_folder, "tag": tag, "storage_key": STORAGE}
        r1 = run("persist1", "sandbox", pa, [])
        r1["outside_after"] = {"ac_entries": len(os.listdir(container_folder)) if os.path.isdir(container_folder) else 0,
                               "storage_entries": storage_entries()}
        run("persist2", "sandbox", dict(pa, prev_run_dir=run_dirs[-1]), [])
        run("positive", "control", {}, CTRL); run("positive", "sandbox", {}, [])
        results["verdicts"] = verdicts(results["tests"])
        print("VERDICTS", json.dumps(results["verdicts"]))
    finally:
        cl = {}
        if listener:
            listener.close()
        for rd in run_dirs:
            shutil.rmtree(rd, ignore_errors=True)
        p = subprocess.run([launcher, "cleanup", "--profile", PROFILE, "--revoke", runtime, "--revoke", runs],
                           capture_output=True, text=True)
        cl["cleanup_stdout"] = p.stdout.strip()
        for d in created_dirs:
            shutil.rmtree(d, ignore_errors=True)
        for c in canaries.values():
            if os.path.exists(c["file"]):
                os.remove(c["file"])
        if reg_created:
            for k in (REGKEY + r"\probe", REGKEY):
                try:
                    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, k)
                except OSError:
                    pass
        os.environ.pop("SPIKE_CANARY_ENV", None)
        cl["canary_dirs_left"] = [d for d in created_dirs if os.path.exists(d)]
        cl["canary_files_left"] = [c["file"] for c in canaries.values() if os.path.exists(c["file"])]
        cl["run_dirs_left"] = [d for d in run_dirs if os.path.exists(d)]
        try:
            winreg.OpenKey(winreg.HKEY_CURRENT_USER, REGKEY).Close(); cl["regkey_left"] = True
        except OSError:
            cl["regkey_left"] = False
        cl["sid"] = sid
        results["cleanup"] = cl
        with open(a.out, "w") as f:
            json.dump(results, f, indent=1)
        print("CLEANUP", json.dumps(cl))


if __name__ == "__main__":
    main()
