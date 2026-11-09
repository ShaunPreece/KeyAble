# Runs the browser tests inside a kill-on-close job object, so headless Edge and its
# helper processes die with this script however it exits, then deletes the test profiles.
# -CandidateFix runs the VIA tests with tests/candidate-fix.js in place of the app's sendVIA.
param([switch]$CandidateFix)
$ErrorActionPreference = 'Stop'
if ($CandidateFix) { $env:KEYABLE_CANDIDATE_FIX = '1' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KillOnCloseJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong R, W, O, RB, WB, OB; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    const int ExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x2000;

    // The handle is never closed: the job ends, killing every process in it, when
    // this process exits and Windows closes the handle.
    public static void AddCurrentProcess() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var info = new ExtendedLimits();
        info.Basic.LimitFlags = KillOnJobClose;
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(info)))
            throw new System.ComponentModel.Win32Exception();
        if (!AssignProcessToJobObject(job, GetCurrentProcess()))
            throw new System.ComponentModel.Win32Exception();
    }
}
'@

[KillOnCloseJob]::AddCurrentProcess()

# Each test file owns one profile folder named keyable-tests-profile*.
$profiles = Join-Path $env:TEMP 'keyable-tests-profile*'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    node --test "tests/*.test.mjs"
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $profiles -ErrorAction SilentlyContinue
}
exit $code
