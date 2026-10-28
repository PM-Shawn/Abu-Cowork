using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeCaptureApproval {
    private delegate bool EnumWindowProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    private static string Text(IntPtr window, bool className) {
        var text = new StringBuilder(512);
        if (className) GetClassName(window, text, text.Capacity);
        else GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    public static bool TryAccept(int processId, string dialogTitle, string acceptLabel) {
        IntPtr button = IntPtr.Zero;
        EnumWindows((window, data) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != processId || !IsWindowVisible(window) || Text(window, true) != "#32770") return true;
            if (Text(window, false) != dialogTitle && Text(window, false) != "Allow Abu to view the current screen?") return true;
            EnumChildWindows(window, (child, childData) => {
                if (!IsWindowVisible(child) || !IsWindowEnabled(child) || Text(child, true) != "Button") return true;
                string label = Text(child, false);
                if (label != acceptLabel && label != "Allow for this task") return true;
                button = child;
                return false;
            }, IntPtr.Zero);
            return button == IntPtr.Zero;
        }, IntPtr.Zero);
        if (button == IntPtr.Zero) return false;
        IntPtr result;
        if (SendMessageTimeout(button, 0x00F5, IntPtr.Zero, IntPtr.Zero, 0x0002, 2000, out result) == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return true;
    }
}
