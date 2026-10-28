using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class AbuInstallerJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    // Owned until process exit: closing this handle also terminates extraction descendants.
    private static IntPtr extractionJob;
    public static void ProtectExtraction()
    {
        extractionJob = CreateJobObject(IntPtr.Zero, null);
        if (extractionJob == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000;
        if (!SetInformationJobObject(extractionJob, 9, ref limits, (uint)Marshal.SizeOf(limits)))
        {
            var error = Marshal.GetLastWin32Error();
            CloseHandle(extractionJob);
            throw new Win32Exception(error);
        }
        using (var process = Process.GetCurrentProcess())
        {
            if (!AssignProcessToJobObject(extractionJob, process.Handle))
            {
                var error = Marshal.GetLastWin32Error();
                CloseHandle(extractionJob);
                throw new Win32Exception(error);
            }
        }
    }

    public static void CompleteExtraction()
    {
        var limits = new ExtendedLimits();
        if (!SetInformationJobObject(extractionJob, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
        CloseHandle(extractionJob);
        extractionJob = IntPtr.Zero;
    }
}
