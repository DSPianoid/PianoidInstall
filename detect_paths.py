#!/usr/bin/env python
# detect_paths.py - environment autodiscovery for PianoidCore build
# Pure stdlib, ASCII-only output. Python 3.8+
# Supports Windows (MSVC + CUDA + SDL2/SDL3 + ASIO) and Linux (gcc + CUDA + SDL2/SDL3).
import argparse
import json
import os
import re
import sys
from pathlib import Path

IS_WINDOWS = sys.platform.startswith("win")
IS_LINUX = sys.platform.startswith("linux")


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
    # Try well-known defaults — scan all editions (Community, Professional, Enterprise, BuildTools)
    pf = os.environ.get("ProgramFiles") or r"C:\Program Files"
    for edition in ("Community", "Professional", "Enterprise", "BuildTools"):
        base = Path(pf) / "Microsoft Visual Studio" / "2022" / edition / "VC" / "Tools" / "MSVC"
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
            # Scan common locations: system drive root, Program Files, home,
            # and popular dev directories.
            bases = []
            candidates = []
            sysdrive = os.environ.get("SystemDrive", "C:")
            bases.append(Path(sysdrive + os.sep))
            if sysdrive != "C:":
                bases.append(Path("C:\\"))
            pf = os.environ.get("ProgramFiles")
            if pf:
                bases.append(Path(pf))
            home = Path.home()
            bases.append(home)
            for dev_dir in ("dev", "Development", "libs", "Libraries", "SDK"):
                bases.append(Path(sysdrive + os.sep) / dev_dir)
                bases.append(home / dev_dir)

            for base in bases:
                if base.exists():
                    candidates.extend(sorted(base.glob("SDL2-*"), key=lambda p: p.name, reverse=True))
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

    # Find SDL2.dll
    dll_path = ""
    if lib64 and Path(lib64).exists():
        dll = Path(lib64) / "SDL2.dll"
        if dll.exists():
            dll_path = str(dll)

    return {
        "sdl2_root": str(Path(root)),
        "sdl2_include": str(inc),
        "sdl2_include_subdir": str(inc2) if inc2.exists() else "",
        "sdl2_libdir": str(lib64) if lib64.exists() else "",
        "sdl2_dll": dll_path,
    }


def _find_sdl3(user_hint=None):
    root = None
    if user_hint:
        root = Path(user_hint)
        if not root.exists():
            return {}
    else:
        # env hint
        env = os.environ.get("SDL3_DIR")
        if env and Path(env).exists():
            root = Path(env)
        else:
            # Scan common locations: system drive root, Program Files, home,
            # and popular dev directories.
            bases = []
            candidates = []
            sysdrive = os.environ.get("SystemDrive", "C:")
            bases.append(Path(sysdrive + os.sep))
            if sysdrive != "C:":
                bases.append(Path("C:\\"))
            pf = os.environ.get("ProgramFiles")
            if pf:
                bases.append(Path(pf))
            home = Path.home()
            bases.append(home)
            for dev_dir in ("dev", "Development", "libs", "Libraries", "SDK"):
                bases.append(Path(sysdrive + os.sep) / dev_dir)
                bases.append(home / dev_dir)

            for base in bases:
                if base.exists():
                    candidates.extend(sorted(base.glob("SDL3-*"), key=lambda p: p.name, reverse=True))
                    candidates.append(base / "SDL3")

            root = next((p for p in candidates if p.exists()), None)
            root = Path(root) if root else None
    if not root:
        return {}
    inc = Path(root) / "include"
    # Some layouts use include\SDL3 (both are valid to add)
    inc2 = inc / "SDL3"
    # lib dir (x64)
    lib64 = Path(root) / "lib" / "x64"
    # if unpacked "SDL3-devel-3.x.x-VC", lib dir may be lib\x64
    if not lib64.exists():
        # try lib
        if (Path(root) / "lib").exists():
            lib64 = Path(root) / "lib"
    if not inc.exists():
        return {}

    # Find SDL3.dll
    dll_path = ""
    if lib64 and Path(lib64).exists():
        dll = Path(lib64) / "SDL3.dll"
        if dll.exists():
            dll_path = str(dll)

    return {
        "sdl3_root": str(Path(root)),
        "sdl3_include": str(inc),
        "sdl3_include_subdir": str(inc2) if inc2.exists() else "",
        "sdl3_libdir": str(lib64) if lib64.exists() else "",
        "sdl3_dll": dll_path,
    }


def _py_info():
    import sysconfig
    py_inc = sysconfig.get_paths().get("include")
    libdir = sysconfig.get_config_var("LIBDIR")
    if not libdir:
        # Windows CPython typically keeps libs next to the base prefix
        libdir = str(Path(sys.base_prefix) / "libs")
    return {"python_include": str(py_inc), "python_libdir": str(libdir)}


# -------- Linux helpers --------

def _find_gcc_linux():
    """Locate g++ on Linux. Required for nvcc -ccbin."""
    cxx = which("g++")
    if cxx:
        return {"gxx": str(cxx)}
    # try clang++ as fallback
    clx = which("clang++")
    if clx:
        return {"gxx": str(clx)}
    return {}


def _find_cuda_linux(user_hint=None):
    """Locate CUDA toolkit on Linux."""
    cand = None
    if user_hint:
        cand = user_hint
    if not cand:
        cand = os.environ.get("CUDA_HOME") or os.environ.get("CUDA_PATH")
    if not cand:
        # Try `nvcc` on PATH and walk up two levels (bin/nvcc)
        nvcc = which("nvcc")
        if nvcc:
            cand = str(Path(nvcc).resolve().parent.parent)
    if not cand:
        # Scan default locations (/usr/local/cuda*, /opt/cuda*).
        for base in ("/usr/local", "/opt"):
            cand = _glob_latest(Path(base), "cuda*")
            if cand:
                break
    if not cand:
        return {}
    cuda_home = Path(cand)
    nvcc = cuda_home / "bin" / "nvcc"
    include = cuda_home / "include"
    # Linux uses lib64 (CUDA 11+) or lib (older)
    lib64 = cuda_home / "lib64"
    if not lib64.exists():
        lib64 = cuda_home / "lib"
    if nvcc.exists() and include.exists() and lib64.exists():
        return {
            "cuda_home": str(cuda_home),
            "cuda_nvcc": str(nvcc),
            "cuda_include": str(include),
            "cuda_libdir": str(lib64),
        }
    return {}


def _pkg_config(pkg):
    """Query pkg-config for cflags/libs of the package. Returns None if pkg-config or pkg not found."""
    pcb = which("pkg-config")
    if not pcb:
        return None
    import subprocess
    try:
        rc = subprocess.run([pcb, "--exists", pkg], capture_output=True)
        if rc.returncode != 0:
            return None
        cflags = subprocess.check_output([pcb, "--cflags", pkg], encoding="utf-8", errors="ignore").strip()
        libs = subprocess.check_output([pcb, "--libs", pkg], encoding="utf-8", errors="ignore").strip()
        prefix = subprocess.check_output([pcb, "--variable=prefix", pkg], encoding="utf-8", errors="ignore").strip()
        # Parse -I and -L flags
        includes = [tok[2:] for tok in cflags.split() if tok.startswith("-I")]
        libdirs = [tok[2:] for tok in libs.split() if tok.startswith("-L")]
        return {"prefix": prefix, "includes": includes, "libdirs": libdirs}
    except Exception:
        return None


def _find_sdl_linux(version, user_hint=None):
    """Locate SDL2 or SDL3 on Linux. version is 2 or 3."""
    pkg = "sdl2" if version == 2 else "sdl3"
    inc_subdir = "SDL2" if version == 2 else "SDL3"
    so_pattern = "libSDL{}.so*".format(version)
    env_var = "SDL{}_DIR".format(version)

    # 1. user hint (root path) -> root/include/SDLn, root/lib
    root = None
    if user_hint:
        root = Path(user_hint)
        if not root.exists():
            return {}
    elif os.environ.get(env_var):
        cand = Path(os.environ[env_var])
        if cand.exists():
            root = cand

    if root:
        inc = root / "include"
        inc2 = inc / inc_subdir
        # lib could be lib64, lib, or lib/x86_64-linux-gnu
        libdir = None
        for cand_lib in ("lib64", "lib", "lib/x86_64-linux-gnu"):
            p = root / cand_lib
            if p.exists() and any(p.glob(so_pattern)):
                libdir = p
                break
        return {
            "sdl{}_root".format(version): str(root),
            "sdl{}_include".format(version): str(inc) if inc.exists() else "",
            "sdl{}_include_subdir".format(version): str(inc2) if inc2.exists() else "",
            "sdl{}_libdir".format(version): str(libdir) if libdir else "",
            "sdl{}_dll".format(version): "",  # No DLL on Linux; runtime loader uses .so
        }

    # 2. pkg-config
    pc = _pkg_config(pkg)
    if pc:
        prefix = pc["prefix"]
        includes = pc["includes"]
        libdirs = pc["libdirs"]
        sdl_inc = ""
        sdl_inc2 = ""
        for inc in includes:
            if inc.endswith("/" + inc_subdir):
                sdl_inc2 = inc
                # include parent
                sdl_inc = str(Path(inc).parent)
            elif not sdl_inc:
                sdl_inc = inc
        if not sdl_inc and prefix:
            sdl_inc = str(Path(prefix) / "include")
        if not sdl_inc2 and sdl_inc and Path(sdl_inc, inc_subdir).exists():
            sdl_inc2 = str(Path(sdl_inc, inc_subdir))
        sdl_libdir = libdirs[0] if libdirs else ""
        if not sdl_libdir and prefix:
            for cand_lib in ("lib64", "lib", "lib/x86_64-linux-gnu"):
                p = Path(prefix) / cand_lib
                if p.exists() and any(p.glob(so_pattern)):
                    sdl_libdir = str(p)
                    break
        return {
            "sdl{}_root".format(version): prefix or sdl_inc or "",
            "sdl{}_include".format(version): sdl_inc,
            "sdl{}_include_subdir".format(version): sdl_inc2,
            "sdl{}_libdir".format(version): sdl_libdir,
            "sdl{}_dll".format(version): "",
        }

    # 3. Distro defaults (Debian/Ubuntu, Fedora, Arch)
    common_inc_roots = ["/usr/include", "/usr/local/include"]
    common_lib_roots = [
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib64",
        "/usr/lib",
        "/usr/local/lib",
    ]
    sdl_inc2 = ""
    for ir in common_inc_roots:
        cand = Path(ir) / inc_subdir
        if cand.exists() and (cand / "SDL.h").exists():
            sdl_inc2 = str(cand)
            sdl_inc = ir
            break
        # SDL3 uses SDL3/SDL.h convention too
    if not sdl_inc2:
        return {}
    sdl_libdir = ""
    for lr in common_lib_roots:
        p = Path(lr)
        if p.exists() and any(p.glob(so_pattern)):
            sdl_libdir = str(p)
            break
    return {
        "sdl{}_root".format(version): str(Path(sdl_inc).parent),
        "sdl{}_include".format(version): sdl_inc,
        "sdl{}_include_subdir".format(version): sdl_inc2,
        "sdl{}_libdir".format(version): sdl_libdir,
        "sdl{}_dll".format(version): "",
    }


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
    # collect raw data — branch by host platform
    py_info = _py_info()
    pybind_info = _find_pybind11()

    if IS_WINDOWS:
        msvc_info = _find_msvc()
        winsdk_info = _find_windows_sdk()
        cuda_info = _find_cuda(args.cuda)
        sdl2_info = _find_sdl2(args.sdl2)
        sdl3_info = _find_sdl3(getattr(args, "sdl3", None))
        gcc_info = {}
    elif IS_LINUX:
        msvc_info = {}
        winsdk_info = {}
        gcc_info = _find_gcc_linux()
        cuda_info = _find_cuda_linux(args.cuda)
        sdl2_info = _find_sdl_linux(2, args.sdl2)
        sdl3_info = _find_sdl_linux(3, getattr(args, "sdl3", None))
    else:
        # Unsupported (macOS, etc.) — fall through with empty info; validate() will report.
        msvc_info = {}
        winsdk_info = {}
        gcc_info = {}
        cuda_info = {}
        sdl2_info = {}
        sdl3_info = {}

    # Determine which SDL drivers are available
    sdl2_available = bool(sdl2_info.get("sdl2_root"))
    sdl3_available = bool(sdl3_info.get("sdl3_root"))

    # Default to SDL3 if available, otherwise SDL2
    default_driver = "SDL3" if sdl3_available else ("SDL2" if sdl2_available else "")

    platform_tag = "windows" if IS_WINDOWS else ("linux" if IS_LINUX else sys.platform)

    # Structure the config to match what setup.py expects
    cfg = {
        # Legacy nested "windows" block kept for back-compat with older setup.py
        # readers; setup.py now also reads from the flat keys below and skips
        # this block on non-Windows builds.
        "windows": {
            "cuda_home": cuda_info.get("cuda_home", "") if IS_WINDOWS else "",
            "visual_studio": {
                "vc_tools_bin_hostx64_x64": str(Path(msvc_info.get("msvc_cl", "")).parent) if msvc_info.get(
                    "msvc_cl") else ""
            },
            "sdl2": {
                "base_path": sdl2_info.get("sdl2_root", "") if IS_WINDOWS else ""
            }
        },
        "platform": platform_tag,
        "cuda_arch_list": _default_arches(),
        "project_root": str(Path(args.project_root).resolve()) if args.project_root else str(Path.cwd().resolve()),

        # Audio driver configuration
        "audio_driver": default_driver,
        "sdl2_available": sdl2_available,
        "sdl3_available": sdl3_available,

        # SDL2 paths
        "sdl2_include": sdl2_info.get("sdl2_include", ""),
        "sdl2_include_subdir": sdl2_info.get("sdl2_include_subdir", ""),
        "sdl2_libdir": sdl2_info.get("sdl2_libdir", ""),
        "sdl2_dll": sdl2_info.get("sdl2_dll", ""),

        # SDL3 paths
        "sdl3_include": sdl3_info.get("sdl3_include", ""),
        "sdl3_include_subdir": sdl3_info.get("sdl3_include_subdir", ""),
        "sdl3_libdir": sdl3_info.get("sdl3_libdir", ""),
        "sdl3_dll": sdl3_info.get("sdl3_dll", ""),

        # Keep flat structure for validation
        "msvc_cl": msvc_info.get("msvc_cl", ""),
        "msvc_tools_root": msvc_info.get("msvc_tools_root", ""),
        "winsdk_root": winsdk_info.get("winsdk_root", ""),
        "gxx": gcc_info.get("gxx", ""),
        "cuda_home": cuda_info.get("cuda_home", ""),
        "cuda_nvcc": cuda_info.get("cuda_nvcc", ""),
        "cuda_include": cuda_info.get("cuda_include", ""),
        "cuda_libdir": cuda_info.get("cuda_libdir", ""),
        "sdl2_root": sdl2_info.get("sdl2_root", ""),
        "sdl3_root": sdl3_info.get("sdl3_root", ""),
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

    # Add SDL includes based on default driver
    if default_driver == "SDL2":
        sdl_inc = sdl2_info.get("sdl2_include")
        if sdl_inc:
            includes.append(sdl_inc)
        sdl_inc2 = sdl2_info.get("sdl2_include_subdir")
        if sdl_inc2:
            includes.append(sdl_inc2)
    elif default_driver == "SDL3":
        sdl_inc = sdl3_info.get("sdl3_include")
        if sdl_inc:
            includes.append(sdl_inc)
        sdl_inc2 = sdl3_info.get("sdl3_include_subdir")
        if sdl_inc2:
            includes.append(sdl_inc2)

    libdirs = []
    if default_driver == "SDL2" and sdl2_info.get("sdl2_libdir"):
        libdirs.append(sdl2_info["sdl2_libdir"])
    elif default_driver == "SDL3" and sdl3_info.get("sdl3_libdir"):
        libdirs.append(sdl3_info["sdl3_libdir"])
    if cuda_info.get("cuda_libdir"):
        libdirs.append(cuda_info["cuda_libdir"])
    if cfg.get("python_libdir"):
        libdirs.append(cfg["python_libdir"])

    cfg["include_dirs"] = includes
    cfg["library_dirs"] = libdirs

    # Set libraries based on default driver and platform
    libs = []
    if default_driver == "SDL2":
        libs.append("SDL2")
    elif default_driver == "SDL3":
        libs.append("SDL3")
    libs.append("cudart")
    if IS_WINDOWS:
        # Windows-specific runtime libs (winmm = MIDI, ole32/advapi32 = COM/ASIO)
        libs.extend(["winmm", "ole32", "advapi32"])
    elif IS_LINUX:
        # POSIX threads + dl for dynamic loading + math for SDL/audio
        libs.extend(["pthread", "dl", "m"])
    cfg["libraries"] = libs

    return cfg


def validate(cfg):
    if IS_WINDOWS:
        req = [
            "msvc_cl",
            "msvc_tools_root",
            "winsdk_root",
            "cuda_home",
            "cuda_nvcc",
            "python_include",
            "python_libdir",
        ]
    elif IS_LINUX:
        req = [
            "gxx",
            "cuda_home",
            "cuda_nvcc",
            "cuda_include",
            "cuda_libdir",
            "python_include",
        ]
    else:
        req = ["cuda_home", "cuda_nvcc", "python_include"]

    missing = [k for k in req if not cfg.get(k)]

    # Require at least one SDL version
    if not cfg.get("sdl2_root") and not cfg.get("sdl3_root"):
        missing.append("sdl2_root or sdl3_root")

    return missing


def main():
    ap = argparse.ArgumentParser(description="Detect build toolchain for PianoidCore (Windows + Linux).")
    ap.add_argument("--out", default="build_config.json", help="Output JSON path (default: build_config.json)")
    ap.add_argument("--cuda", default=None,
                    help="Hint for CUDA root (e.g. C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.x or /usr/local/cuda)")
    ap.add_argument("--sdl2", default=None, help="Hint for SDL2 root")
    ap.add_argument("--sdl3", default=None, help="Hint for SDL3 root")
    ap.add_argument("--project-root", default=None, help="Root of the project (default: cwd)")
    ap.add_argument("--quiet", action="store_true", help="Print only the summary line")
    args = ap.parse_args()

    if not args.quiet:
        log("=== PianoidCore System Configuration Detection ===")
        log("Platform: %s" % sys.platform)
        log("Checking Python environment...")
        log("  Python version: %s" % sys.version.split()[0])
        log("  Virtual environment: %s" % ("Yes" if sys.prefix != sys.base_prefix else "No"))

    cfg = build_config(args)
    missing = validate(cfg)
    out_path = Path(args.out)

    if missing:
        if not args.quiet:
            log("")
            log("ERROR: Missing required components:")
            for k in missing:
                log("  - %s" % k)
            log("")
            log("Components found:")
            if IS_WINDOWS:
                log("  MSVC cl.exe:  %s" % (cfg.get("msvc_cl") or "NOT FOUND"))
                log("  WinSDK root:  %s" % (cfg.get("winsdk_root") or "NOT FOUND"))
            elif IS_LINUX:
                log("  g++:          %s" % (cfg.get("gxx") or "NOT FOUND"))
            log("  CUDA home:    %s" % (cfg.get("cuda_home") or "NOT FOUND"))
            log("  CUDA nvcc:    %s" % (cfg.get("cuda_nvcc") or "NOT FOUND"))
            log("  SDL2 root:    %s" % (cfg.get("sdl2_root") or "NOT FOUND"))
            log("  SDL3 root:    %s" % (cfg.get("sdl3_root") or "NOT FOUND"))
            log("  Python inc:   %s" % (cfg.get("python_include") or "NOT FOUND"))
            log("")
            log("HINTS")
            if IS_WINDOWS:
                log("  Use flags to provide hints, for example:")
                log("    python detect_paths.py --cuda \"C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.9\"")
                log("    python detect_paths.py --sdl2 \"C:\\SDL2-2.30.0\"")
                log("    python detect_paths.py --sdl3 \"C:\\SDL3-3.2.0\"")
                log("  Or set environment variables: CUDA_PATH, SDL2_DIR, SDL3_DIR, VCToolsInstallDir")
            elif IS_LINUX:
                log("  Install missing packages, for example:")
                log("    sudo apt install build-essential nvidia-cuda-toolkit libsdl3-dev libsdl2-dev")
                log("  Or pass hints:")
                log("    python detect_paths.py --cuda /usr/local/cuda --sdl3 /usr/local")
                log("  Or set environment variables: CUDA_HOME, SDL3_DIR, SDL2_DIR")
        else:
            # Even in quiet mode, print error details so build.log captures them
            log("ERROR: Missing: %s" % ", ".join(missing))
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