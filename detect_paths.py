#!/usr/bin/env python
# detect_paths.py - environment autodiscovery for PianoidCore build
# Pure stdlib, ASCII-only output. Python 3.8+
import argparse
import json
import os
import re
import sys
from pathlib import Path


# -------- helpers --------

def log(msg):
    print(msg, flush=True)


def which(p):
    # like shutil.which but minimal
    path = os.environ.get("PATH", "")
    exts = os.environ.get("PATHEXT", ".EXE;.BAT;.CMD").split(";")
    cand = Path(p)
    if cand.exists():
        return str(cand)
    for d in path.split(os.pathsep):
        d = d.strip('"')
        f = Path(d) / p
        if f.exists():
            return str(f)
        # try with PATHEXT
        for e in exts:
            f2 = Path(d) / (p + e)
            if f2.exists():
                return str(f2)
    return None


def _first_existing(paths):
    for p in paths:
        if p and Path(p).exists():
            return str(Path(p))
    return None


def _glob_latest(root, pattern):
    root = Path(root)
    if not root.exists():
        return None
    found = sorted(root.glob(pattern), key=lambda p: p.name, reverse=True)
    return str(found[0]) if found else None


def _try_vswhere():
    # vswhere default locations
    pf86 = os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)"
    vswhere = Path(pf86) / "Microsoft Visual Studio" / "Installer" / "vswhere.exe"
    if vswhere.exists():
        return str(vswhere)
    return None


def _find_msvc():
    # Try env first
    cl = which("cl")
    if cl:
        cl = str(Path(cl))
        # best-effort derive tools root three parents up to \VC\Tools\MSVC\<ver>\bin\Hostx64\x64\cl.exe
        p = Path(cl)
        tools_root = None
        try:
            idx = p.parts.index("MSVC")
            tools_root = Path(*p.parts[:idx + 2])  # ...\MSVC\<ver>
        except Exception:
            tools_root = p.parent.parent.parent  # rough fallback
        return {"msvc_cl": cl, "msvc_tools_root": str(tools_root)}
    # Try env var VCToolsInstallDir
    vt = os.environ.get("VCToolsInstallDir")
    if vt:
        cand = Path(vt) / "bin" / "Hostx64" / "x64" / "cl.exe"
        if cand.exists():
            return {"msvc_cl": str(cand), "msvc_tools_root": str(Path(vt))}
    # Try vswhere
    vsw = _try_vswhere()
    if vsw:
        import subprocess, json as _json
        try:
            out = subprocess.check_output(
                [vsw, "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                 "-latest", "-format", "json"],
                encoding="utf-8", errors="ignore"
            )
            arr = _json.loads(out) if out.strip() else []
            if arr:
                inst = arr[0]
                install_root = inst.get("installationPath")
                if install_root:
                    tools_root = _glob_latest(Path(install_root) / "VC" / "Tools" / "MSVC", "*")
                    if tools_root:
                        cl = Path(tools_root) / "bin" / "Hostx64" / "x64" / "cl.exe"
                        if cl.exists():
                            return {"msvc_cl": str(cl), "msvc_tools_root": str(Path(tools_root))}
        except Exception:
            pass
    # Try well-known default
    pf = os.environ.get("ProgramFiles") or r"C:\Program Files"
    base = Path(pf) / "Microsoft Visual Studio" / "2022" / "Community" / "VC" / "Tools" / "MSVC"
    tools_root = _glob_latest(base, "*")
    if tools_root:
        cl = Path(tools_root) / "bin" / "Hostx64" / "x64" / "cl.exe"
        if cl.exists():
            return {"msvc_cl": str(cl), "msvc_tools_root": str(Path(tools_root))}
    return {}


def _find_windows_sdk():
    # Prefer env
    wdir = os.environ.get("WindowsSdkDir")
    if wdir and Path(wdir).exists():
        # try to extract version if present as ...\Windows Kits\10\
        inc = Path(wdir) / "Include"
        ver = None
        if inc.exists():
            children = [p.name for p in inc.iterdir() if p.is_dir() and re.match(r"^\d+\.\d+\.\d+\.\d+$", p.name)]
            ver = sorted(children, reverse=True)[0] if children else None
        return {"winsdk_root": str(Path(wdir)), "winsdk_version": ver}
    # Common default
    pf86 = os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)"
    kits10 = Path(pf86) / "Windows Kits" / "10"
    if kits10.exists():
        inc = kits10 / "Include"
        ver = None
        if inc.exists():
            children = [p.name for p in inc.iterdir() if p.is_dir() and re.match(r"^\d+\.\d+\.\d+\.\d+$", p.name)]
            ver = sorted(children, reverse=True)[0] if children else None
        return {"winsdk_root": str(kits10), "winsdk_version": ver}
    return {}


def _find_cuda(user_hint=None):
    cand = None
    if user_hint:
        cand = user_hint
    if not cand:
        cand = os.environ.get("CUDA_PATH")
    if not cand:
        # scan default
        pf = os.environ.get("ProgramFiles") or r"C:\Program Files"
        cand = _glob_latest(Path(pf) / "NVIDIA GPU Computing Toolkit" / "CUDA", "v*")
    if not cand:
        return {}
    cuda_home = Path(cand)
    nvcc = cuda_home / "bin" / "nvcc.exe"
    include = cuda_home / "include"
    lib64 = cuda_home / "lib" / "x64"
    if nvcc.exists() and include.exists() and lib64.exists():
        return {
            "cuda_home": str(cuda_home),
            "cuda_nvcc": str(nvcc),
            "cuda_include": str(include),
            "cuda_libdir": str(lib64),
        }
    return {}


def _find_sdl2(user_hint=None):
    root = None
    if user_hint:
        root = Path(user_hint)
        if not root.exists():
            return {}
    else:
        # env hint
        env = os.environ.get("SDL2_DIR") or os.environ.get("SDL_DIR")
        if env and Path(env).exists():
            root = Path(env)
        else:
            # common defaults
            # Prefer versioned dir if present, otherwise C:\SDL2
            bases = []
            candidates = []
            sysdrive = os.environ.get("SystemDrive", "C:")
            bases.append(Path(sysdrive + os.sep))

            # Also check a literal C:\ as a fallback search base
            bases.append(Path("C:\\"))

            for base in bases:
                candidates.extend(base.glob("SDL2-*"))
                candidates.append(base / "SDL2")

            root = next((p for p in candidates if p.exists()), None)
            root = Path(root) if root else None
    if not root:
        return {}
    inc = Path(root) / "include"
    # Some layouts use include\SDL2 (both are valid to add)
    inc2 = inc / "SDL2"
    # lib dir (x64)
    lib64 = Path(root) / "lib" / "x64"
    # if unpacked "SDL2-devel-2.x.x-VC", lib dir may be lib\x64
    if not lib64.exists():
        # try lib
        if (Path(root) / "lib").exists():
            lib64 = Path(root) / "lib"
    if not inc.exists():
        return {}
    return {
        "sdl2_root": str(Path(root)),
        "sdl2_include": str(inc),
        "sdl2_include_sdl2": str(inc2) if inc2.exists() else "",
        "sdl2_libdir": str(lib64) if lib64.exists() else "",
    }


def _py_info():
    import sysconfig
    py_inc = sysconfig.get_paths().get("include")
    libdir = sysconfig.get_config_var("LIBDIR")
    if not libdir:
        # Windows CPython typically keeps libs next to the base prefix
        libdir = str(Path(sys.base_prefix) / "libs")
    return {"python_include": str(py_inc), "python_libdir": str(libdir)}


def _find_pybind11():
    try:
        import pybind11  # type: ignore
        return {"pybind11_include": str(Path(pybind11.get_include()))}
    except Exception:
        return {}


def _default_arches():
    # Safe defaults for modern RTX; override via env CUDA_ARCHES="80,86,89"
    env = os.environ.get("CUDA_ARCHES")
    if env:
        parts = [p.strip() for p in env.split(",") if p.strip().isdigit()]
        if parts:
            return parts
    # Try to detect with torch if present
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            cc = torch.cuda.get_device_capability()
            maj, minr = cc
            return [str(maj) + str(minr)]
    except Exception:
        pass
    return ["80", "86", "89"]


def build_config(args):
    cfg = {}
    # collect raw data
    msvc_info = _find_msvc()
    winsdk_info = _find_windows_sdk()
    cuda_info = _find_cuda(args.cuda)
    sdl2_info = _find_sdl2(args.sdl2)
    py_info = _py_info()
    pybind_info = _find_pybind11()

    # Structure the config to match what setup.py expects
    cfg = {
        "windows": {
            "cuda_home": cuda_info.get("cuda_home", ""),
            "visual_studio": {
                "vc_tools_bin_hostx64_x64": str(Path(msvc_info.get("msvc_cl", "")).parent) if msvc_info.get(
                    "msvc_cl") else ""
            },
            "sdl2": {
                "base_path": sdl2_info.get("sdl2_root", "")
            }
        },
        "cuda_arch_list": _default_arches(),
        "project_root": str(Path(args.project_root).resolve()) if args.project_root else str(Path.cwd().resolve()),

        # Keep flat structure for validation
        "msvc_cl": msvc_info.get("msvc_cl", ""),
        "msvc_tools_root": msvc_info.get("msvc_tools_root", ""),
        "winsdk_root": winsdk_info.get("winsdk_root", ""),
        "cuda_home": cuda_info.get("cuda_home", ""),
        "cuda_nvcc": cuda_info.get("cuda_nvcc", ""),
        "sdl2_root": sdl2_info.get("sdl2_root", ""),
        "python_include": py_info.get("python_include", ""),
        "python_libdir": py_info.get("python_libdir", ""),
        "pybind11_include": pybind_info.get("pybind11_include", ""),
    }

    # augment derived include/lib search paths for convenience consumers
    includes = []
    if cfg.get("pybind11_include"):
        includes.append(cfg["pybind11_include"])
    if cuda_info.get("cuda_include"):
        includes.append(cuda_info["cuda_include"])
    includes.append(str(Path(cfg["project_root"]) / "pianoid_cuda"))
    includes.append(cfg["python_include"])
    sdl_inc = sdl2_info.get("sdl2_include")
    if sdl_inc:
        includes.append(sdl_inc)
    sdl_inc2 = sdl2_info.get("sdl2_include_sdl2")
    if sdl_inc2:
        includes.append(sdl_inc2)

    libdirs = []
    if sdl2_info.get("sdl2_libdir"):
        libdirs.append(sdl2_info["sdl2_libdir"])
    if cuda_info.get("cuda_libdir"):
        libdirs.append(cuda_info["cuda_libdir"])
    if cfg.get("python_libdir"):
        libdirs.append(cfg["python_libdir"])

    cfg["include_dirs"] = includes
    cfg["library_dirs"] = libdirs
    cfg["libraries"] = ["SDL2", "cudart", "winmm", "ole32", "advapi32"]

    return cfg


def validate(cfg):
    req = [
        "msvc_cl",
        "msvc_tools_root",
        "winsdk_root",
        "cuda_home",
        "cuda_nvcc",
        "sdl2_root",
        "python_include",
        "python_libdir",
    ]
    missing = [k for k in req if not cfg.get(k)]
    return missing


def main():
    ap = argparse.ArgumentParser(description="Detect build toolchain for PianoidCore (Windows).")
    ap.add_argument("--out", default="build_config.json", help="Output JSON path (default: build_config.json)")
    ap.add_argument("--cuda", default=None,
                    help="Hint for CUDA root, e.g. C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.x")
    ap.add_argument("--sdl2", default=None, help="Hint for SDL2 root, e.g. C:\\SDL2-2.30.0")
    ap.add_argument("--project-root", default=None, help="Root of the project (default: cwd)")
    ap.add_argument("--quiet", action="store_true", help="Print only the summary line")
    args = ap.parse_args()

    if not args.quiet:
        log("=== PianoidCore System Configuration Detection ===")
        log("Checking Python environment...")
        log("  Python version: %s" % sys.version.split()[0])
        log("  Virtual environment: %s" % ("Yes" if sys.prefix != sys.base_prefix else "No"))

    cfg = build_config(args)
    missing = validate(cfg)
    out_path = Path(args.out)

    if missing:
        if not args.quiet:
            log("")
            log("Missing required components:")
            for k in missing:
                log("  - %s" % k)
            log("")
            log("HINTS")
            log("  Use flags to provide hints, for example:")
            log("    python detect_paths.py --cuda \"C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.9\"")
            log("    python detect_paths.py --sdl2 \"C:\\SDL2-2.30.0\"")
        # do not write output on failure
        return 2

    # write JSON
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    if not args.quiet:
        log("Detection Summary: OK")
        log("Configuration saved to %s" % str(out_path))
    return 0


if __name__ == "__main__":
    code = main()
    sys.exit(code)