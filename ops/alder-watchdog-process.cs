using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Read the live process CWD from the target process PEB. Failure is intentional:
// the watchdog must defer rather than infer ownership when Windows denies access.
public static class AlderWatchdogProcess
{
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicInformation
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2a;
        public IntPtr Reserved2b;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, out BasicInformation info, int length, out int returnLength);

    private static byte[] Read(IntPtr process, IntPtr address, int length)
    {
        var buffer = new byte[length];
        IntPtr read;
        if (!ReadProcessMemory(process, address, buffer, (IntPtr)length, out read) || read.ToInt64() != length)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "PEB_READ_FAILED");
        return buffer;
    }

    public static string GetCurrentDirectory(int processId)
    {
        if (IntPtr.Size != 8) throw new PlatformNotSupportedException("64_BIT_POWERSHELL_REQUIRED");
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, processId);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OPEN_PROCESS_FAILED");
        try
        {
            BasicInformation info;
            int returned;
            var status = NtQueryInformationProcess(process, 0, out info, Marshal.SizeOf(typeof(BasicInformation)), out returned);
            if (status != 0 || info.PebBaseAddress == IntPtr.Zero) throw new InvalidOperationException("PROCESS_BASIC_INFORMATION_FAILED");
            var parameterBytes = Read(process, IntPtr.Add(info.PebBaseAddress, 0x20), 8);
            var parameters = new IntPtr(BitConverter.ToInt64(parameterBytes, 0));
            if (parameters == IntPtr.Zero) throw new InvalidOperationException("PROCESS_PARAMETERS_MISSING");
            var unicode = Read(process, IntPtr.Add(parameters, 0x38), 16);
            var length = BitConverter.ToUInt16(unicode, 0);
            var buffer = new IntPtr(BitConverter.ToInt64(unicode, 8));
            if (length == 0 || buffer == IntPtr.Zero || length % 2 != 0) throw new InvalidOperationException("PROCESS_CWD_INVALID");
            return Encoding.Unicode.GetString(Read(process, buffer, length));
        }
        finally { CloseHandle(process); }
    }
}
