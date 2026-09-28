using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

// An isolated native test target, never a product component. JSONL contains only
// marker equality and owned HWNDs, never the arbitrary text entered into a field.
internal static class DesktopFixture
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    private static string scenario;
    private static string marker;
    private static Form main;
    private static Form secondary;
    private static TextBox mainText;
    private static TextBox secondaryText;
    private static readonly List<KeyValuePair<string, Form>> windows = new List<KeyValuePair<string, Form>>();
    private static readonly System.Windows.Forms.Timer settle = new System.Windows.Forms.Timer();
    private static long sequence;
    private static int cancelCount;
    private static bool pendingText;
    private static bool shuttingDown;
    private static int unexpectedWrites;

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length != 2 || !Regex.IsMatch(args[1], @"\AABU_CU_[A-Z0-9_]{1,80}\z")
            || Array.IndexOf(new[] { "edit", "modal-cancel", "nested-modal", "window-switch" }, args[0]) < 0) return 2;
        scenario = args[0];
        marker = args[1];
        Console.OutputEncoding = new UTF8Encoding(false);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        settle.Interval = 400;
        settle.Tick += delegate { settle.Stop(); pendingText = false; EvaluateWrites(); Emit(); };

        main = NewWindow("main", "Abu CU Desktop", new Size(660, 390));
        mainText = NewTextBox(main, "Document body");
        if (scenario == "window-switch")
        {
            Button open = new Button { Text = "Open secondary window", AccessibleName = "Open secondary window", Dock = DockStyle.Bottom, Height = 42 };
            open.Click += delegate { OpenSecondary(); };
            main.Controls.Add(open);
        }
        main.Shown += delegate
        {
            mainText.Focus();
            // EOF is a parent-lifetime channel only: stdin accepts no commands.
            Thread monitor = new Thread(delegate()
            {
                try { while (Console.In.Read() != -1) { } }
                catch (System.IO.IOException) { }
                try { main.BeginInvoke(new Action(Shutdown)); }
                catch (InvalidOperationException) { }
            });
            monitor.IsBackground = true;
            monitor.Start();
            if (scenario == "modal-cancel" || scenario == "nested-modal")
                main.BeginInvoke(new Action(delegate { ShowModal(main, false); }));
        };
        main.FormClosing += delegate { shuttingDown = true; settle.Stop(); };
        Application.Run(main);
        settle.Dispose();
        return 0;
    }

    private static Form NewWindow(string role, string caption, Size size)
    {
        Form form = new Form { Text = caption, AccessibleName = caption, ClientSize = size,
            StartPosition = FormStartPosition.CenterScreen, AutoScaleMode = AutoScaleMode.Dpi };
        windows.Add(new KeyValuePair<string, Form>(role, form));
        form.Shown += delegate
        {
            // windowsHide keeps the console hidden, but its startup SW_HIDE also
            // overrides WinForms' first native show. Explicitly show only this
            // owned GUI HWND after that first show has consumed startup state.
            ShowWindow(form.Handle, 5); // SW_SHOW
            Emit();
        };
        form.Activated += delegate { Emit(); };
        form.FormClosed += delegate { Emit(); };
        return form;
    }

    private static TextBox NewTextBox(Form owner, string name)
    {
        TextBox box = new TextBox { Name = name, AccessibleName = name, Multiline = true,
            AcceptsReturn = true, Dock = DockStyle.Fill, MaxLength = 256, Font = new Font("Segoe UI", 13) };
        box.TextChanged += delegate
        {
            pendingText = true;
            settle.Stop();
            settle.Start();
            Emit();
        };
        owner.Controls.Add(box);
        return box;
    }

    private static void ShowModal(Form owner, bool nested)
    {
        if (shuttingDown) return;
        using (Form dialog = NewWindow(nested ? "nested" : "dialog", nested ? "Abu CU Nested Dialog" : "Abu CU Dialog", new Size(390, 160)))
        {
            dialog.ControlBox = false;
            dialog.MinimizeBox = false;
            dialog.MaximizeBox = false;
            dialog.ShowInTaskbar = false;
            dialog.StartPosition = FormStartPosition.CenterParent;
            Label label = new Label { Text = "Cancel this dialog to return to the document.", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter };
            Button cancel = new Button { Text = "Cancel dialog", AccessibleName = "Cancel dialog", Dock = DockStyle.Bottom, Height = 44 };
            cancel.Click += delegate { cancelCount++; dialog.Close(); };
            dialog.Controls.Add(label);
            dialog.Controls.Add(cancel);
            dialog.CancelButton = cancel;
            if (!nested && scenario == "nested-modal")
                dialog.Shown += delegate { dialog.BeginInvoke(new Action(delegate { ShowModal(dialog, true); })); };
            dialog.ShowDialog(owner);
        }
        Emit();
    }

    private static void OpenSecondary()
    {
        if (secondary != null && !secondary.IsDisposed) { secondary.Activate(); return; }
        // Keep at most one record for each role when the secondary is reopened.
        windows.RemoveAll(delegate(KeyValuePair<string, Form> item) { return item.Key == "secondary"; });
        secondary = NewWindow("secondary", "Abu CU Secondary", new Size(610, 350));
        secondaryText = NewTextBox(secondary, "Secondary document");
        secondary.Shown += delegate { secondaryText.Focus(); };
        secondary.Show(main);
        Emit();
    }

    private static void EvaluateWrites()
    {
        unexpectedWrites = 0;
        if (mainText != null && mainText.Text.Length > 0 && (scenario == "window-switch" || mainText.Text != marker)) unexpectedWrites++;
        if (secondaryText != null && secondaryText.Text.Length > 0 && secondaryText.Text != marker) unexpectedWrites++;
    }

    private static void Emit()
    {
        if (shuttingDown) return;
        bool mainVisible = false;
        bool secondaryVisible = false;
        StringBuilder owned = new StringBuilder();
        int depth = 0;
        foreach (KeyValuePair<string, Form> item in windows)
        {
            Form form = item.Value;
            if (form.IsDisposed || !form.IsHandleCreated || !form.Visible || !IsWindowVisible(form.Handle)) continue;
            if (owned.Length > 0) owned.Append(',');
            owned.Append("{\"role\":\"").Append(item.Key).Append("\",\"windowId\":\"0x")
                .Append(form.Handle.ToInt64().ToString("X")).Append("\"}");
            if (item.Key == "main") mainVisible = true;
            if (item.Key == "secondary") secondaryVisible = true;
            if (item.Key == "dialog" || item.Key == "nested") depth++;
        }
        // Closed/hidden destinations cannot claim equality from retained TextBox
        // content: marker flags use the exact same visible-window set as JSONL.
        bool mainMatch = mainVisible && mainText != null && !mainText.IsDisposed && mainText.Text == marker;
        bool secondaryMatch = secondaryVisible && secondaryText != null && !secondaryText.IsDisposed && secondaryText.Text == marker;
        bool match = !pendingText && (scenario == "window-switch" ? secondaryMatch : mainMatch);
        string state = "{\"version\":1,\"sequence\":" + (++sequence) + ",\"pid\":" + Process.GetCurrentProcess().Id
            + ",\"scenario\":\"" + scenario + "\",\"windows\":[" + owned + "],\"dialogDepth\":" + depth
            + ",\"cancelCount\":" + cancelCount + ",\"markerPresent\":" + BooleanJson(match)
            + ",\"mainMarkerPresent\":" + BooleanJson(mainMatch) + ",\"secondaryMarkerPresent\":" + BooleanJson(secondaryMatch)
            + ",\"unexpectedWrites\":" + unexpectedWrites + "}";
        try { Console.WriteLine(state); Console.Out.Flush(); }
        catch (System.IO.IOException) { Shutdown(); }
    }

    private static string BooleanJson(bool value) { return value ? "true" : "false"; }

    private static void Shutdown()
    {
        if (shuttingDown) return;
        shuttingDown = true;
        settle.Stop();
        for (int i = windows.Count - 1; i >= 0; i--)
            if (!windows[i].Value.IsDisposed) windows[i].Value.Close();
        Application.ExitThread();
    }
}
