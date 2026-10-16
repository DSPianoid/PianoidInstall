// PianoidSandbox.exe - P5a spike: run untrusted analysis Python in an AppContainer (no capabilities)
// inside a Job Object. Feasibility prototype, not production code.
//
//   PianoidSandbox.exe setup   --profile NAME --grant-rx DIR [--grant-rx DIR ...]
//   PianoidSandbox.exe run     --profile NAME --python EXE --run-dir DIR --script FILE
//                              [--wall-s 60] [--cpu-s 60] [--mem-mb 2048] [--stdout-cap 20480] [--stderr-cap 8192]
//                              [--no-child-policy] [--no-job] [--keep-grant]
//   PianoidSandbox.exe cleanup --profile NAME [--revoke DIR ...]
//   PianoidSandbox.exe sid     --profile NAME
//
// `run` prints one JSON object on stdout: exit code, capped stdout/stderr, job notifications, the out\ listing.
// Build: build.bat (csc from .NET Framework 4, no SDK needed).

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

static class Native
{
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint capCount, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int GetAppContainerFolderPath(string sidString, out IntPtr path);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
    [DllImport("advapi32.dll")] public static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll")] public static extern int GetLengthSid(IntPtr sid);
    [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
    [DllImport("ole32.dll")] public static extern void CoTaskMemFree(IntPtr p);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags,
        IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr key, out IntPtr ov, uint ms);

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT { public IntPtr CompletionKey; public IntPtr CompletionPort; }

    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_SUSPENDED = 0x4,
        CREATE_UNICODE_ENVIRONMENT = 0x400, DETACHED_PROCESS = 0x8, BELOW_NORMAL_PRIORITY_CLASS = 0x4000;
    public static readonly IntPtr ATTR_SECURITY_CAPABILITIES = (IntPtr)0x00020009;
    public static readonly IntPtr ATTR_HANDLE_LIST = (IntPtr)0x00020002;
    public static readonly IntPtr ATTR_CHILD_PROCESS_POLICY = (IntPtr)0x0002000E;
    public const int STARTF_USESTDHANDLES = 0x100;
}

static class Program
{
    const int HR_ALREADY_EXISTS = unchecked((int)0x800700B7);

    static Dictionary<string, List<string>> ParseArgs(string[] a, int from)
    {
        var d = new Dictionary<string, List<string>>();
        for (int i = from; i < a.Length; i++)
        {
            if (!a[i].StartsWith("--")) throw new ArgumentException("unexpected arg " + a[i]);
            string k = a[i].Substring(2);
            if (!d.ContainsKey(k)) d[k] = new List<string>();
            if (i + 1 < a.Length && !a[i + 1].StartsWith("--")) d[k].Add(a[++i]); else d[k].Add("true");
        }
        return d;
    }
    static string Get(Dictionary<string, List<string>> d, string k, string def)
    { return d.ContainsKey(k) ? d[k][d[k].Count - 1] : def; }
    static List<string> All(Dictionary<string, List<string>> d, string k)
    { return d.ContainsKey(k) ? d[k] : new List<string>(); }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length < 1) { Console.Error.WriteLine("usage: setup|run|cleanup|sid ..."); return 2; }
            var o = ParseArgs(args, 1);
            string profile = Get(o, "profile", "pianoid.analysis.spike");
            switch (args[0])
            {
                case "setup": return Setup(profile, All(o, "grant-rx"));
                case "sid": Console.WriteLine(SidString(GetSid(profile, false))); return 0;
                case "cleanup": return Cleanup(profile, All(o, "revoke"));
                case "run": return Run(profile, o);
            }
            Console.Error.WriteLine("unknown verb " + args[0]); return 2;
        }
        catch (Exception e) { Console.Error.WriteLine("launcher error: " + e); return 3; }
    }

    // --- AppContainer profile -------------------------------------------------------------------
    static IntPtr GetSid(string profile, bool create)
    {
        IntPtr sid;
        if (create)
        {
            int hr = Native.CreateAppContainerProfile(profile, profile, "Pianoid assistant analysis sandbox (P5a spike)", IntPtr.Zero, 0, out sid);
            if (hr == 0) return sid;
            if (hr != HR_ALREADY_EXISTS) throw new Win32Exception(hr, "CreateAppContainerProfile 0x" + hr.ToString("X8"));
        }
        int h2 = Native.DeriveAppContainerSidFromAppContainerName(profile, out sid);
        if (h2 != 0) throw new Win32Exception(h2, "DeriveAppContainerSidFromAppContainerName 0x" + h2.ToString("X8"));
        return sid;
    }
    static string SidString(IntPtr sid)
    {
        IntPtr s; if (!Native.ConvertSidToStringSid(sid, out s)) throw new Win32Exception();
        string r = Marshal.PtrToStringUni(s); Native.LocalFree(s); return r;
    }
    static string ContainerFolder(string sidStr)
    {
        IntPtr p; if (Native.GetAppContainerFolderPath(sidStr, out p) != 0) return null;
        string r = Marshal.PtrToStringUni(p); Native.CoTaskMemFree(p); return r;
    }

    static void Grant(string dir, string sidStr, FileSystemRights rights)
    {
        var di = new DirectoryInfo(dir);
        var acl = di.GetAccessControl(AccessControlSections.Access);
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sidStr), rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        di.SetAccessControl(acl);   // SetNamedSecurityInfo: propagates the inheritable ACE to existing children
    }
    static void Revoke(string dir, string sidStr)
    {
        var di = new DirectoryInfo(dir);
        if (!di.Exists) return;
        var acl = di.GetAccessControl(AccessControlSections.Access);
        acl.PurgeAccessRules(new SecurityIdentifier(sidStr));
        di.SetAccessControl(acl);
    }

    static int Setup(string profile, List<string> rxDirs)
    {
        var sw = Stopwatch.StartNew();
        string sid = SidString(GetSid(profile, true));
        foreach (var d in rxDirs) Grant(d, sid, FileSystemRights.ReadAndExecute);
        Console.WriteLine("{\"profile\":" + J(profile) + ",\"sid\":" + J(sid) + ",\"container_folder\":" + J(ContainerFolder(sid))
            + ",\"granted_rx\":" + JArr(rxDirs) + ",\"ms\":" + sw.ElapsedMilliseconds + "}");
        return 0;
    }
    static int Cleanup(string profile, List<string> dirs)
    {
        string sid = null;
        try { sid = SidString(GetSid(profile, false)); } catch { }
        if (sid != null) foreach (var d in dirs) Revoke(d, sid);
        int hr = Native.DeleteAppContainerProfile(profile);
        Console.WriteLine("{\"profile\":" + J(profile) + ",\"sid\":" + J(sid) + ",\"delete_hr\":\"0x" + hr.ToString("X8") + "\"}");
        return hr == 0 ? 0 : 1;
    }

    // --- run ---------------------------------------------------------------------------------------
    static int Run(string profile, Dictionary<string, List<string>> o)
    {
        var total = Stopwatch.StartNew();
        string python = Path.GetFullPath(Get(o, "python", null));
        string runDir = Path.GetFullPath(Get(o, "run-dir", null));
        string script = Get(o, "script", "code.py");
        int wallS = int.Parse(Get(o, "wall-s", "60"));
        int cpuS = int.Parse(Get(o, "cpu-s", wallS.ToString()));
        long memMb = long.Parse(Get(o, "mem-mb", "2048"));
        int outCap = int.Parse(Get(o, "stdout-cap", "20480"));
        int errCap = int.Parse(Get(o, "stderr-cap", "8192"));
        bool useJob = !o.ContainsKey("no-job");
        bool childPolicy = !o.ContainsKey("no-child-policy");
        bool keepGrant = o.ContainsKey("keep-grant");

        IntPtr sidPtr = GetSid(profile, false);
        string sid = SidString(sidPtr);
        Directory.CreateDirectory(Path.Combine(runDir, "out"));
        Directory.CreateDirectory(Path.Combine(runDir, "tmp"));
        Grant(runDir, sid, FileSystemRights.Modify);
        long tGrant = total.ElapsedMilliseconds;

        // Environment from an allow-list only: nothing of the parent's (no ANTHROPIC_*, PIANOID_*, USERPROFILE, PATH).
        string sysRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            {"SystemRoot", sysRoot}, {"windir", sysRoot}, {"SystemDrive", sysRoot.Substring(0, 2)},
            {"PATH", Path.GetDirectoryName(python) + ";" + sysRoot + @"\System32"},
            {"TEMP", Path.Combine(runDir, "tmp")}, {"TMP", Path.Combine(runDir, "tmp")},
            {"HOME", runDir}, {"USERPROFILE", runDir}, {"LOCALAPPDATA", Path.Combine(runDir, "tmp")},  // LOCALAPPDATA is mandatory for an AppContainer CreateProcess (else error 203) {"MPLBACKEND", "Agg"}, {"MPLCONFIGDIR", Path.Combine(runDir, "tmp")},
            {"CUDA_VISIBLE_DEVICES", "-1"}, {"PYTHONIOENCODING", "utf-8"},
            {"OMP_NUM_THREADS", "2"}, {"OPENBLAS_NUM_THREADS", "2"},
            {"NUMBER_OF_PROCESSORS", Environment.GetEnvironmentVariable("NUMBER_OF_PROCESSORS") ?? "1"},
        };
        foreach (var name in All(o, "env-copy")) env[name] = Environment.GetEnvironmentVariable(name) ?? "";
        var envSb = new StringBuilder();
        foreach (var kv in env) envSb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        envSb.Append('\0');
        IntPtr envBlock = Marshal.StringToHGlobalUni(envSb.ToString());

        // stdout / stderr pipes; only these two handles are inherited (PROC_THREAD_ATTRIBUTE_HANDLE_LIST).
        var outPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
        var errPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
        IntPtr hOut = outPipe.ClientSafePipeHandle.DangerousGetHandle();
        IntPtr hErr = errPipe.ClientSafePipeHandle.DangerousGetHandle();

        // Attribute list: security capabilities (AppContainer, zero capabilities), handle list, child-process policy.
        var caps = new Native.SECURITY_CAPABILITIES { AppContainerSid = sidPtr, Capabilities = IntPtr.Zero, CapabilityCount = 0 };
        IntPtr pCaps = Marshal.AllocHGlobal(Marshal.SizeOf(caps)); Marshal.StructureToPtr(caps, pCaps, false);
        IntPtr pHandles = Marshal.AllocHGlobal(IntPtr.Size * 2);
        Marshal.WriteIntPtr(pHandles, 0, hOut); Marshal.WriteIntPtr(pHandles, IntPtr.Size, hErr);
        IntPtr pChild = Marshal.AllocHGlobal(4); Marshal.WriteInt32(pChild, 1); // PROCESS_CREATION_CHILD_PROCESS_RESTRICTED
        bool appContainer = !o.ContainsKey("no-appcontainer");   // control runs only: same job + env, no AppContainer
        int nAttr = 1 + (childPolicy ? 1 : 0) + (appContainer ? 1 : 0);
        IntPtr attrSize = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, nAttr, 0, ref attrSize);
        IntPtr attrList = Marshal.AllocHGlobal(attrSize);
        if (!Native.InitializeProcThreadAttributeList(attrList, nAttr, 0, ref attrSize)) throw new Win32Exception();
        if (appContainer && !Native.UpdateProcThreadAttribute(attrList, 0, Native.ATTR_SECURITY_CAPABILITIES, pCaps, (IntPtr)Marshal.SizeOf(caps), IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "attr security capabilities");
        if (!Native.UpdateProcThreadAttribute(attrList, 0, Native.ATTR_HANDLE_LIST, pHandles, (IntPtr)(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "attr handle list");
        if (childPolicy && !Native.UpdateProcThreadAttribute(attrList, 0, Native.ATTR_CHILD_PROCESS_POLICY, pChild, (IntPtr)4, IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "attr child process policy");

        var si = new Native.STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
        si.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
        si.StartupInfo.hStdOutput = hOut; si.StartupInfo.hStdError = hErr; si.StartupInfo.hStdInput = IntPtr.Zero;
        si.lpAttributeList = attrList;

        // Job Object: memory, CPU time, one process, kill on close, UI restrictions, below-normal priority.
        IntPtr job = IntPtr.Zero, port = IntPtr.Zero;
        if (useJob)
        {
            job = Native.CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            var lim = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            lim.Basic.LimitFlags = 0x4 /*JOB_TIME*/ | 0x8 /*ACTIVE_PROCESS*/ | 0x20 /*PRIORITY_CLASS*/ | 0x100 /*PROCESS_MEMORY*/
                | 0x200 /*JOB_MEMORY*/ | 0x400 /*DIE_ON_UNHANDLED_EXCEPTION*/ | 0x2000 /*KILL_ON_JOB_CLOSE*/;
            lim.Basic.PerJobUserTimeLimit = (long)cpuS * 10000000L;
            lim.Basic.ActiveProcessLimit = 1;
            lim.Basic.PriorityClass = Native.BELOW_NORMAL_PRIORITY_CLASS;
            lim.ProcessMemoryLimit = (UIntPtr)(ulong)(memMb << 20);
            lim.JobMemoryLimit = (UIntPtr)(ulong)(memMb << 20);
            SetJob(job, 9, lim);
            SetJob(job, 4, Convert.ToUInt32(Get(o, "ui-limits", "0xFF"), 16)); // JOB_OBJECT_UILIMIT_ALL: handles, read/write clipboard, sysparams, displaysettings, globalatoms, desktop, exitwindows
            port = Native.CreateIoCompletionPort((IntPtr)(-1), IntPtr.Zero, UIntPtr.Zero, 1);
            SetJob(job, 7, new Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey = job, CompletionPort = port });
        }

        string cmdLine = "\"" + python + "\" -I -B -X utf8 \"" + script + "\"";
        Native.PROCESS_INFORMATION pi;
        long tSpawn0 = total.ElapsedMilliseconds;
        bool ok = Native.CreateProcess(python, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, true,
            Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT | Native.DETACHED_PROCESS,  // no console => no conhost.exe child (the child-process policy would block it: 0xC0000142)
            o.ContainsKey("inherit-env") ? IntPtr.Zero : envBlock, runDir, ref si, out pi);
        int createErr = Marshal.GetLastWin32Error();
        outPipe.DisposeLocalCopyOfClientHandle(); errPipe.DisposeLocalCopyOfClientHandle();
        if (!ok)
        {
            Console.WriteLine("{\"ok\":false,\"error\":" + J("CreateProcess failed (" + createErr + "): " + new Win32Exception(createErr).Message) + "}");
            if (!keepGrant) Revoke(runDir, sid);
            return 1;
        }
        if (useJob && !Native.AssignProcessToJobObject(job, pi.hProcess))
        {
            int e = Marshal.GetLastWin32Error();
            Native.TerminateProcess(pi.hProcess, 0xC0DE0002);
            throw new Win32Exception(e, "AssignProcessToJobObject");
        }
        Native.ResumeThread(pi.hThread);

        var outBuf = new CappedReader(outPipe, outCap); var errBuf = new CappedReader(errPipe, errCap);
        var to = new Thread(outBuf.Pump) { IsBackground = true }; to.Start();
        var te = new Thread(errBuf.Pump) { IsBackground = true }; te.Start();

        bool wallKilled = false;
        if (Native.WaitForSingleObject(pi.hProcess, (uint)wallS * 1000) != 0)
        {
            wallKilled = true;
            if (useJob) Native.TerminateJobObject(job, 0xC0DE0001); else Native.TerminateProcess(pi.hProcess, 0xC0DE0002);
            Native.WaitForSingleObject(pi.hProcess, 5000);
        }
        long elapsedRun = total.ElapsedMilliseconds - tSpawn0;
        uint exitCode; Native.GetExitCodeProcess(pi.hProcess, out exitCode);
        to.Join(2000); te.Join(2000);

        var msgs = new List<string>(); uint totalProcs = 0; double cpuUsed = 0;
        if (useJob)
        {
            uint n; UIntPtr key; IntPtr ov;
            while (Native.GetQueuedCompletionStatus(port, out n, out key, out ov, 0)) msgs.Add(JobMsg(n));
            var acct = QueryJob<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(job, 1);
            totalProcs = acct.TotalProcesses; cpuUsed = acct.TotalUserTime / 1e7;
            Native.CloseHandle(job); Native.CloseHandle(port); // kill-on-close takes anything left
        }
        Native.CloseHandle(pi.hThread); Native.CloseHandle(pi.hProcess);
        if (!keepGrant) Revoke(runDir, sid);

        // out\ caps: <= 20 files, <= 5 MB each, <= 20 MB total (reported; over-cap files are flagged, not returned).
        var files = new StringBuilder("["); long sum = 0; int count = 0;
        foreach (var f in new DirectoryInfo(Path.Combine(runDir, "out")).GetFiles("*", SearchOption.TopDirectoryOnly))
        {
            count++; sum += f.Length;
            bool over = count > 20 || f.Length > 5L * 1024 * 1024 || sum > 20L * 1024 * 1024;
            if (count > 1) files.Append(',');
            files.Append("{\"name\":" + J(f.Name) + ",\"size\":" + f.Length + ",\"over_cap\":" + (over ? "true" : "false") + "}");
        }
        files.Append(']');

        Console.WriteLine("{\"ok\":true,\"exit\":" + exitCode + ",\"exit_hex\":\"0x" + exitCode.ToString("X8") + "\""
            + ",\"wall_killed\":" + (wallKilled ? "true" : "false") + ",\"job_msgs\":" + JArr(msgs)
            + ",\"job_total_processes\":" + totalProcs + ",\"cpu_user_s\":" + cpuUsed.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture)
            + ",\"stdout\":" + J(outBuf.Text()) + ",\"stdout_truncated\":" + (outBuf.Truncated ? "true" : "false")
            + ",\"stderr\":" + J(errBuf.Text()) + ",\"stderr_truncated\":" + (errBuf.Truncated ? "true" : "false")
            + ",\"files\":" + files + ",\"ms_grant\":" + tGrant + ",\"ms_run\":" + elapsedRun + ",\"ms_total\":" + total.ElapsedMilliseconds + "}");
        return 0;
    }

    static string JobMsg(uint n)
    {
        switch (n)
        {
            case 1: return "END_OF_JOB_TIME"; case 2: return "END_OF_PROCESS_TIME"; case 3: return "ACTIVE_PROCESS_LIMIT";
            case 4: return "ACTIVE_PROCESS_ZERO"; case 6: return "NEW_PROCESS"; case 7: return "EXIT_PROCESS";
            case 8: return "ABNORMAL_EXIT_PROCESS"; case 9: return "PROCESS_MEMORY_LIMIT"; case 10: return "JOB_MEMORY_LIMIT";
        }
        return "MSG_" + n;
    }
    static void SetJob<T>(IntPtr job, int cls, T v)
    {
        int sz = Marshal.SizeOf(typeof(T)); IntPtr p = Marshal.AllocHGlobal(sz);
        Marshal.StructureToPtr(v, p, false);
        bool ok = Native.SetInformationJobObject(job, cls, p, (uint)sz);
        int e = Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(p);
        if (!ok) throw new Win32Exception(e, "SetInformationJobObject class " + cls);
    }
    static void SetJob(IntPtr job, int cls, uint v)
    {
        IntPtr p = Marshal.AllocHGlobal(4); Marshal.WriteInt32(p, (int)v);
        bool ok = Native.SetInformationJobObject(job, cls, p, 4);
        int e = Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(p);
        if (!ok) throw new Win32Exception(e, "SetInformationJobObject class " + cls);
    }
    static T QueryJob<T>(IntPtr job, int cls)
    {
        int sz = Marshal.SizeOf(typeof(T)); IntPtr p = Marshal.AllocHGlobal(sz);
        Native.QueryInformationJobObject(job, cls, p, (uint)sz, IntPtr.Zero);
        T r = (T)Marshal.PtrToStructure(p, typeof(T)); Marshal.FreeHGlobal(p); return r;
    }

    static string J(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\""); else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n"); else if (c == '\r') sb.Append("\\r"); else if (c == '\t') sb.Append("\\t");
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
    static string JArr(List<string> l)
    {
        var sb = new StringBuilder("[");
        for (int i = 0; i < l.Count; i++) { if (i > 0) sb.Append(','); sb.Append(J(l[i])); }
        return sb.Append(']').ToString();
    }
}

// Keeps the first `cap` bytes and keeps draining the pipe so the child never blocks on a full pipe.
class CappedReader
{
    readonly Stream s; readonly int cap; readonly MemoryStream kept = new MemoryStream();
    public bool Truncated;
    public CappedReader(Stream s, int cap) { this.s = s; this.cap = cap; }
    public void Pump()
    {
        var buf = new byte[8192]; int n;
        try
        {
            while ((n = s.Read(buf, 0, buf.Length)) > 0)
            {
                int room = cap - (int)kept.Length;
                if (room > 0) kept.Write(buf, 0, Math.Min(room, n));
                if (n > room) Truncated = true;
            }
        }
        catch (IOException) { }
    }
    public string Text()
    {
        string t = Encoding.UTF8.GetString(kept.ToArray());
        return Truncated ? t + "\n[... truncated at " + cap + " bytes]" : t;
    }
}
